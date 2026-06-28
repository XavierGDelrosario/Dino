// Unit tests for the `translate` edge function's PURE helpers (extracted to
// supabase/functions/translate/_lib.ts so they run in Node/Vitest — the Deno
// edge file itself can't be imported here). Covers the high-bug-density logic:
// JWT decode, CORS resolution, lang mapping, and the dedupe/dictionary_ref
// projection that CLAUDE.md flags as breaking common words if dropped.
import { describe, it, expect } from "vitest";
import {
  corsHeaders,
  dropOffScriptTranslations,
  groupByInput,
  lemmaCandidates,
  mergeProviderResults,
  parseAllowedOrigins,
  resolvePerInputWithCandidates,
  projectMany,
  projectRows,
  resolveServiceKey,
  toGoogleLang,
  userIdFromAuth,
  type ProviderResult,
} from "../../supabase/functions/translate/_lib";

/** Build a JWT-shaped token (unpadded base64url payload, like a real JWT). */
function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("toGoogleLang", () => {
  it("lowercases app codes to ISO-639-1", () => {
    expect(toGoogleLang("JA")).toBe("ja");
    expect(toGoogleLang("EN")).toBe("en");
    expect(toGoogleLang("KO")).toBe("ko");
    expect(toGoogleLang("ZH")).toBe("zh");
  });
  it("maps split-script Chinese to regional codes", () => {
    expect(toGoogleLang("ZH-Hant")).toBe("zh-TW");
    expect(toGoogleLang("ZH-Hans")).toBe("zh-CN");
  });
  it("trims surrounding whitespace", () => {
    expect(toGoogleLang("  JA  ")).toBe("ja");
  });
});

describe("userIdFromAuth", () => {
  it("returns the `sub` from a Bearer token", () => {
    expect(userIdFromAuth(`Bearer ${jwtWith({ sub: "user-123" })}`)).toBe("user-123");
  });
  it("works without the Bearer prefix and restores base64url padding", () => {
    // a sub length chosen so the payload's base64 needs padding
    expect(userIdFromAuth(jwtWith({ sub: "abcde" }))).toBe("abcde");
  });
  it("returns null for a token with no sub (e.g. the anon api key)", () => {
    expect(userIdFromAuth(`Bearer ${jwtWith({ role: "anon" })}`)).toBeNull();
  });
  it("returns null for a missing header", () => {
    expect(userIdFromAuth(null)).toBeNull();
  });
  it("returns null for a malformed token (doesn't throw)", () => {
    expect(userIdFromAuth("Bearer not-a-jwt")).toBeNull();
    expect(userIdFromAuth("garbage")).toBeNull();
    expect(userIdFromAuth("Bearer a.!!!.c")).toBeNull();
  });
});

describe("parseAllowedOrigins", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseAllowedOrigins("https://a.com, https://b.com ,")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(null)).toEqual([]);
  });
});

describe("corsHeaders", () => {
  it("an empty allow-list grants '*' (dev)", () => {
    expect(corsHeaders("https://anything.com", [])["Access-Control-Allow-Origin"]).toBe("*");
  });
  it("echoes an allowed origin (and sets Vary: Origin)", () => {
    const h = corsHeaders("https://app.dino.com", ["https://app.dino.com", "https://dino.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.dino.com");
    expect(h["Vary"]).toBe("Origin");
  });
  it("denies a disallowed origin with 'null'", () => {
    expect(
      corsHeaders("https://evil.com", ["https://app.dino.com"])["Access-Control-Allow-Origin"],
    ).toBe("null");
  });
  it("denies a missing Origin against a non-empty list", () => {
    expect(corsHeaders(null, ["https://app.dino.com"])["Access-Control-Allow-Origin"]).toBe("null");
  });
});

describe("projectRows", () => {
  const JA_SENSE: ProviderResult = {
    translation: "cat (esp. the domestic cat)",
    inputReading: "ねこ",
    headword: "猫",
    entryId: "1467640",
    sensePos: 0,
  };

  it("JA→EN: stores the headword as input and builds ref '<entry>:<pos>'", () => {
    const [row] = projectRows([JA_SENSE], "ねこ", "JA", "EN", 2);
    expect(row.input).toBe("猫"); // canonical headword, not the kana search term
    expect(row.dictionary_ref).toBe("1467640:0");
    expect(row.input_reading).toBe("ねこ");
    expect(row.jmdict_entry_id).toBe("1467640");
    expect(row.projection_version).toBe(2);
    expect(row.is_verified).toBe(true);
  });

  it("projects frequency + part_of_speech; difficulty_override is null (no JLPT in JMdict)", () => {
    const sense: ProviderResult = { ...JA_SENSE, frequency: 7, partOfSpeech: ["n"] };
    const [row] = projectRows([sense], "ねこ", "JA", "EN", 3);
    expect(row.frequency).toBe(7);
    expect(row.part_of_speech).toEqual(["n"]);
    expect(row.difficulty_override).toBeNull();
  });

  it("MT/JMdict-without-rank rows carry null frequency + POS", () => {
    const [row] = projectRows([JA_SENSE], "ねこ", "JA", "EN", 3);
    expect(row.frequency).toBeNull();
    expect(row.part_of_speech).toBeNull();
  });

  it("EN→JA: no headword + entryId → ref '<input>:<entry>'", () => {
    const enja: ProviderResult = {
      translation: "猫",
      translationReading: "ねこ",
      entryId: "1467640",
      sensePos: 0,
    };
    const [row] = projectRows([enja], "cat", "EN", "JA", 2);
    expect(row.input).toBe("cat"); // EN search term kept as-is (no headword)
    expect(row.dictionary_ref).toBe("cat:1467640");
    expect(row.translation_reading).toBe("ねこ");
  });

  it("MT fallback: no entryId → ref 'mt:<input>', input is the search term", () => {
    const mt: ProviderResult = { translation: "[MT] hi" };
    const [row] = projectRows([mt], "やあ", "JA", "EN", 2);
    expect(row.dictionary_ref).toBe("mt:やあ");
    expect(row.input).toBe("やあ");
    expect(row.jmdict_entry_id).toBeNull();
    expect(row.jmdict_sense_pos).toBeNull();
  });

  it("DEDUPEs senses that collapse to the same (headword, translation) — the 私→'I; me' x2 / Postgres 21000 guard", () => {
    const dupe: ProviderResult = { translation: "I; me", headword: "私", entryId: "1311110", sensePos: 0 };
    const dupe2: ProviderResult = { translation: "I; me", headword: "私", entryId: "1311110", sensePos: 1 };
    const rows = projectRows([dupe, dupe2], "私", "JA", "EN", 2);
    expect(rows).toHaveLength(1); // second dropped → no duplicate onConflict key
    expect(rows[0].dictionary_ref).toBe("1311110:0"); // keeps the first (primary)
  });

  it("keeps distinct translations of the same headword as separate rows", () => {
    const a: ProviderResult = { translation: "spicy", headword: "辛い", entryId: "1365850", sensePos: 0 };
    const b: ProviderResult = { translation: "painful", headword: "辛い", entryId: "1365860", sensePos: 0 };
    const rows = projectRows([a, b], "辛い", "JA", "EN", 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dictionary_ref)).toEqual(["1365850:0", "1365860:0"]);
  });

  it("defaults a null sensePos to 0 in the ref", () => {
    const r: ProviderResult = { translation: "x", headword: "字", entryId: "999", sensePos: null };
    expect(projectRows([r], "字", "JA", "EN", 2)[0].dictionary_ref).toBe("999:0");
  });
});

describe("projectMany (batch projection)", () => {
  it("flattens several inputs' senses into one row list", () => {
    const rows = projectMany(
      [
        { input: "猫", results: [{ translation: "cat", headword: "猫", entryId: "1467640", sensePos: 0 }] },
        { input: "犬", results: [{ translation: "dog", headword: "犬", entryId: "1216630", sensePos: 0 }] },
      ],
      "JA", "EN", 3,
    );
    expect(rows.map((r) => r.translation)).toEqual(["cat", "dog"]);
    expect(rows.map((r) => r.dictionary_ref)).toEqual(["1467640:0", "1216630:0"]);
  });

  it("de-dupes ACROSS inputs by dictionary_ref (no duplicate onConflict key)", () => {
    // A kanji and its kana both in the batch resolve to the SAME JMdict sense.
    const sense: ProviderResult = { translation: "to go", headword: "行く", entryId: "1578850", sensePos: 0 };
    const rows = projectMany(
      [
        { input: "行く", results: [sense] },
        { input: "いく", results: [sense] },
      ],
      "JA", "EN", 3,
    );
    expect(rows).toHaveLength(1); // one row, so the single upsert can't hit 21000
    expect(rows[0].dictionary_ref).toBe("1578850:0");
  });
});

describe("mergeProviderResults (WordNet-first EN→JA merge)", () => {
  const wn = (entryId: string, translation: string, sensePos: number): ProviderResult =>
    ({ translation, entryId, sensePos });

  it("leads with the primary (WordNet) results, then appends fallback", () => {
    const primary = [wn("100", "春", 0), wn("101", "泉", 1)];
    const fallback = [wn("200", "ばね", 0)];
    const merged = mergeProviderResults(primary, fallback, 12);
    expect(merged.map((r) => r.entryId)).toEqual(["100", "101", "200"]);
  });

  it("re-numbers sensePos contiguously so the merged order survives the cache read", () => {
    const primary = [wn("100", "春", 0), wn("101", "泉", 1)];
    const fallback = [wn("200", "ばね", 0)]; // fallback also starts at 0 — must be renumbered
    const merged = mergeProviderResults(primary, fallback, 12);
    expect(merged.map((r) => r.sensePos)).toEqual([0, 1, 2]);
  });

  it("dedupes by entryId, keeping the primary occurrence (same JMdict entry = same row)", () => {
    const primary = [wn("100", "春", 0)];
    const fallback = [wn("100", "spring-from-gloss", 0), wn("201", "泉", 1)];
    const merged = mergeProviderResults(primary, fallback, 12);
    expect(merged.map((r) => r.entryId)).toEqual(["100", "201"]);
    expect(merged[0].translation).toBe("春"); // WordNet's projection wins
  });

  it("empty primary → pure fallback (renumbered) — the no-WordNet-coverage case", () => {
    const fallback = [wn("200", "x", 5), wn("201", "y", 9)];
    const merged = mergeProviderResults([], fallback, 12);
    expect(merged.map((r) => r.entryId)).toEqual(["200", "201"]);
    expect(merged.map((r) => r.sensePos)).toEqual([0, 1]);
  });

  it("caps the merged list at the limit", () => {
    const primary = Array.from({ length: 10 }, (_, i) => wn(`p${i}`, `t${i}`, i));
    const fallback = Array.from({ length: 10 }, (_, i) => wn(`f${i}`, `g${i}`, i));
    const merged = mergeProviderResults(primary, fallback, 12);
    expect(merged).toHaveLength(12);
    expect(merged.slice(0, 10).map((r) => r.entryId)).toEqual(primary.map((r) => r.entryId));
  });

  it("a skipped duplicate doesn't consume a slot", () => {
    const primary = [wn("100", "a", 0)];
    const fallback = [wn("100", "dup", 0), wn("101", "b", 1), wn("102", "c", 2)];
    const merged = mergeProviderResults(primary, fallback, 3);
    expect(merged.map((r) => r.entryId)).toEqual(["100", "101", "102"]); // dup dropped, c still fits
  });
});

describe("groupByInput", () => {
  const rows = [
    { input: "猫", input_reading: "ねこ", jmdict_sense_pos: 1 },
    { input: "猫", input_reading: "ねこ", jmdict_sense_pos: 0 },
    { input: "犬", input_reading: "いぬ", jmdict_sense_pos: 0 },
  ];

  it("matches a term by headword and returns its senses primary-first", () => {
    const map = groupByInput(rows, ["猫"]);
    expect(map.get("猫")?.map((r) => r.jmdict_sense_pos)).toEqual([0, 1]); // sorted, nulls last
  });

  it("matches a kana search by input_reading (kana → kanji-headword rows)", () => {
    const map = groupByInput(rows, ["ねこ"]);
    expect(map.get("ねこ")?.map((r) => r.input)).toEqual(["猫", "猫"]);
  });

  it("gives an empty array for a term with no matching row", () => {
    const map = groupByInput(rows, ["鳥"]);
    expect(map.get("鳥")).toEqual([]);
  });

  it("sorts MT rows (null sense_pos) last", () => {
    const mixed = [
      { input: "x", input_reading: null, jmdict_sense_pos: null },
      { input: "x", input_reading: null, jmdict_sense_pos: 0 },
    ];
    expect(groupByInput(mixed, ["x"]).get("x")?.map((r) => r.jmdict_sense_pos)).toEqual([0, null]);
  });
});

describe("resolveServiceKey", () => {
  it("prefers the explicit secret over the legacy key", () => {
    expect(resolveServiceKey({ SERVICE_ROLE_SECRET: "sb_secret_x", SUPABASE_SERVICE_ROLE_KEY: "legacy" }))
      .toBe("sb_secret_x");
  });
  it("falls back to the legacy key when the secret is unset", () => {
    expect(resolveServiceKey({ SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe("legacy");
  });
  it("falls back when the secret is empty/whitespace (NOT used as a blank credential)", () => {
    expect(resolveServiceKey({ SERVICE_ROLE_SECRET: "", SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe("legacy");
    expect(resolveServiceKey({ SERVICE_ROLE_SECRET: "   ", SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe("legacy");
  });
  it("returns undefined when neither is set (real misconfiguration)", () => {
    expect(resolveServiceKey({})).toBeUndefined();
    expect(resolveServiceKey({ SERVICE_ROLE_SECRET: "", SUPABASE_SERVICE_ROLE_KEY: "" })).toBeUndefined();
  });
});

describe("dropOffScriptTranslations (target-language script guard)", () => {
  const r = (translation: string, entryId: string): ProviderResult => ({ translation, entryId });

  it("JA target: drops results with no kana/kanji (ＰＥＮ, ＢＩＳ, ASCII)", () => {
    const kept = dropOffScriptTranslations([
      r("国際的", "1"), // kanji — kept
      r("ＰＥＮ", "2"), // full-width Latin initialism — dropped
      r("ＢＩＳ", "3"), // full-width Latin initialism — dropped
      r("NPO", "4"), // ASCII initialism — dropped
    ], "JA");
    expect(kept.map((x) => x.translation)).toEqual(["国際的"]);
  });

  it("JA target: keeps katakana loanwords + mixed Latin+JA (ペン, 春, Ｔシャツ)", () => {
    const input = [r("ペン", "1"), r("春", "2"), r("Ｔシャツ", "3")];
    expect(dropOffScriptTranslations(input, "ja")).toEqual(input); // case-insensitive, all kept
  });

  it("target with no script entry (EN) imposes no constraint — identity pass", () => {
    const input = [r("run", "1"), r("PEN", "2")]; // JA->EN translations are legitimately Latin
    expect(dropOffScriptTranslations(input, "EN")).toEqual(input);
  });
});

describe("lemmaCandidates (EN morphy lemmatization seam)", () => {
  // The candidate list always LEADS with the surface form (morphy tries it first),
  // then offers base-form candidates the caller verifies against the dictionary.
  const has = (input: string, lemma: string) => lemmaCandidates(input, "EN").includes(lemma);

  it("leads with the surface form for every word", () => {
    expect(lemmaCandidates("cats", "EN")[0]).toBe("cats");
    expect(lemmaCandidates("run", "EN")[0]).toBe("run");
  });

  it("offers the base for regular plurals & 3rd-person -s (cats→cat, boxes→box, studies→study)", () => {
    expect(has("cats", "cat")).toBe(true);
    expect(has("boxes", "box")).toBe(true);
    expect(has("studies", "study")).toBe(true);
    expect(has("flies", "fly")).toBe(true);
  });

  it("offers the base for regular past/gerund (walked→walk, liked→like, making→make)", () => {
    expect(has("walked", "walk")).toBe(true);
    expect(has("liked", "like")).toBe(true);
    expect(has("making", "make")).toBe(true);
    expect(has("studied", "study")).toBe(true);
  });

  it("collapses doubled consonants (running→run, stopped→stop, bigger→big)", () => {
    expect(has("running", "run")).toBe(true);
    expect(has("stopped", "stop")).toBe(true);
    expect(has("bigger", "big")).toBe(true);
  });

  it("maps irregular verbs (ran→run, ate→eat, went→go, brought→bring)", () => {
    expect(has("ran", "run")).toBe(true);
    expect(has("ate", "eat")).toBe(true);
    expect(has("went", "go")).toBe(true);
    expect(has("brought", "bring")).toBe(true);
    expect(has("was", "be")).toBe(true);
  });

  it("maps irregular plurals (mice→mouse, feet→foot, children→child, leaves→leaf)", () => {
    expect(has("mice", "mouse")).toBe(true);
    expect(has("feet", "foot")).toBe(true);
    expect(has("children", "child")).toBe(true);
    expect(has("leaves", "leaf")).toBe(true); // via the -ves rule
  });

  it("is identity (surface only) for non-EN sources — JA arrives pre-lemmatized", () => {
    expect(lemmaCandidates("猫", "JA")).toEqual(["猫"]);
    expect(lemmaCandidates("perro", "ES")).toEqual(["perro"]);
  });

  it("does not over-strip short words or -ss (is→be via map, not 'i'; class stays)", () => {
    expect(lemmaCandidates("class", "EN")).not.toContain("clas"); // -ss guarded
    expect(lemmaCandidates("is", "EN")).toContain("be"); // irregular, not a strip
  });
});

describe("resolvePerInputWithCandidates (batch/paragraph lemmatization)", () => {
  const r = (translation: string, entryId: string): ProviderResult => ({ translation, entryId });
  const cands = (m: Record<string, string[]>) => new Map(Object.entries(m));
  const byCand = (m: Record<string, ProviderResult[]>) => new Map(Object.entries(m));

  it("re-keys a lemma's senses back to the inflected surface token (cats→cat)", () => {
    const out = resolvePerInputWithCandidates(
      ["cats"],
      cands({ cats: ["cats", "cat"] }),
      byCand({ cat: [r("猫", "e1")] }), // WordNet only resolves the lemma
      byCand({}),
      "JA",
      8,
    );
    expect(out.get("cats")?.map((x) => x.translation)).toEqual(["猫"]); // surface-keyed
  });

  it("prefers the SURFACE form when it resolves (spring stays spring, not a stripped lemma)", () => {
    const out = resolvePerInputWithCandidates(
      ["spring"],
      cands({ spring: ["spring", "spr"] }),
      byCand({ spring: [r("春", "e1")], spr: [r("WRONG", "e9")] }),
      byCand({}),
      "JA",
      8,
    );
    expect(out.get("spring")?.map((x) => x.translation)).toEqual(["春"]);
  });

  it("uses the WINNING lemma for the gloss fallback too", () => {
    const out = resolvePerInputWithCandidates(
      ["ran"],
      cands({ ran: ["ran", "run"] }),
      byCand({ run: [r("走る", "e1")] }), // WordNet hit on the lemma
      byCand({ run: [r("経営する", "e2")] }), // gloss keyed by the same lemma
      "JA",
      8,
    );
    expect(out.get("ran")?.map((x) => x.translation)).toEqual(["走る", "経営する"]);
  });

  it("off-script WordNet rows don't count as a hit (falls through to the next candidate)", () => {
    const out = resolvePerInputWithCandidates(
      ["pens"],
      cands({ pens: ["pens", "pen"] }),
      byCand({ pens: [r("ＰＥＮ", "e9")], pen: [r("ペン", "e1")] }),
      byCand({}),
      "JA",
      8,
    );
    expect(out.get("pens")?.map((x) => x.translation)).toEqual(["ペン"]); // skipped ＰＥＮ
  });

  it("omits a token with no senses at all", () => {
    const out = resolvePerInputWithCandidates(
      ["xyzzy"],
      cands({ xyzzy: ["xyzzy"] }),
      byCand({}),
      byCand({}),
      "JA",
      8,
    );
    expect(out.has("xyzzy")).toBe(false);
  });
});
