// The level estimate is DUPLICATED across two runtimes: SQL (estimated_band /
// not_leveled_vocab, migrations 20260776–78) and the client (services/proficiency/
// estimate.ts). History and the Lists summary use the SQL; the "?" panel, the recaps and
// the level filter use the client. If they drift, the same word reads N3 in one place and
// "—" in another — so the shape of the rule is pinned here against the migration text.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  ESTIMATE_BIN_WIDTH,
  ESTIMATE_TOP_BIN,
  NAME_ENTRY_MIN,
  NOT_LEVELED_POS,
  estimatedBand,
  getProficiency,
  isLevelableVocab,
  setLevelEstimateBins,
} from "@/services/proficiency";

const EXCLUDES = readFileSync("supabase/migrations/20260776_history_unranked_excludes.sql", "utf8");
const ESTIMATE = readFileSync("supabase/migrations/20260777_level_estimate.sql", "utf8");

// What 20260777 measured on prod (2026-09-28): Zipf 3.0–3.5 → N2, 3.5+ → N3.
const PROD_BINS = [
  { language: "JA", freq_bin: 6, band: 4 },
  ...[7, 8, 9, 10, 11, 12].map((b) => ({ language: "JA", freq_bin: b, band: 3 })),
];

describe("estimate rule mirrors the SQL", () => {
  it("bins the same way as estimated_band()", () => {
    expect(ESTIMATE).toContain(`LEAST(p_frequency / ${ESTIMATE_BIN_WIDTH}, ${ESTIMATE_TOP_BIN})`);
    expect(ESTIMATE).toContain("WHERE p_frequency IS NOT NULL");
  });

  it("excludes exactly not_leveled_vocab()'s POS tags and name range", () => {
    const arr = EXCLUDES.match(/p_pos <@ ARRAY\[([^\]]+)\]/);
    expect(arr, "not_leveled_vocab's POS array").not.toBeNull();
    const sqlTags = arr![1].match(/'([^']+)'/g)!.map((t) => t.slice(1, -1));
    expect(new Set(sqlTags)).toEqual(NOT_LEVELED_POS);
    expect(EXCLUDES).toContain(`>= ${NAME_ENTRY_MIN}`);
  });
});

describe("isLevelableVocab", () => {
  it("drops senses that are ONLY grammar / affix / interjection, and JMdict names", () => {
    expect(isLevelableVocab(["prt"], "2028990")).toBe(false);
    expect(isLevelableVocab(["suf"], "1")).toBe(false);
    expect(isLevelableVocab(["int"], "1")).toBe(false);
    expect(isLevelableVocab(["n"], "5747047")).toBe(false); // とき, the Shinkansen
  });
  it("keeps content senses, mixed tags, and words with no dictionary data", () => {
    expect(isLevelableVocab(["adv"], "2158950")).toBe(true);
    expect(isLevelableVocab(["n", "suf"], "1")).toBe(true);
    expect(isLevelableVocab(null, null)).toBe(true);
    expect(isLevelableVocab([], null)).toBe(true);
  });
});

describe("getProficiency with estimates", () => {
  beforeEach(() => setLevelEstimateBins(PROD_BINS));
  const ja = (o: Partial<Parameters<typeof getProficiency>[0]>) =>
    getProficiency({ sourceLang: "JA", proficiencyBand: null, ...o });

  it("the curated band always wins, and says so", () => {
    expect(ja({ proficiencyBand: 1, frequency: 450 })).toMatchObject({ label: "N5", source: "curated" });
  });

  it("fills the gap from frequency: N3 floor, N2 for Zipf 3.0–3.5, nothing below 3.0", () => {
    expect(ja({ frequency: 450, partOfSpeech: ["n"] })).toMatchObject({ label: "N3", source: "estimated" });
    expect(ja({ frequency: 800 })).toMatchObject({ label: "N3", source: "estimated" }); // pooled top bin
    expect(ja({ frequency: 320 })).toMatchObject({ label: "N2", source: "estimated" });
    expect(ja({ frequency: 299 })).toBeNull();
    expect(ja({ frequency: null })).toBeNull(); // custom word / MT row
  });

  it("never estimates grammar or names", () => {
    expect(ja({ frequency: 700, partOfSpeech: ["prt"] })).toBeNull();
    expect(ja({ frequency: 450, partOfSpeech: ["n"], jmdictEntryId: "5747047" })).toBeNull();
  });

  it("a language with no measured bins gets curated levels only", () => {
    expect(estimatedBand("EN", 450)).toBeNull();
    expect(getProficiency({ sourceLang: "EN", proficiencyBand: null, frequency: 450 })).toBeNull();
  });

  it("before the table loads, nothing is estimated (curated only)", () => {
    setLevelEstimateBins([]);
    expect(ja({ frequency: 450 })).toBeNull();
    expect(ja({ proficiencyBand: 3 })).toMatchObject({ label: "N3", source: "curated" });
  });
});
