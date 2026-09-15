// The JLPT band rule shared by the JMdict ingest and the in-place re-level script.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bandForWriting, parseProficiency, PROFICIENCY_URL } from "../../scripts/lib/proficiency";

const table = parseProficiency(
  ["為\tため\t2", "件\tけん\t3", "文\tぶん\t3", "何\tなに\t1", "何\tなん\t2", "あいにく\tあいにく\t3", "コンピューター\tコンピューター\t2"].join("\n"),
);

describe("bandForWriting", () => {
  // Quality report #24: 為 read い is a koto string, not the N4 word ため.
  it("levels a kanji writing only for the entry that reads it the listed way", () => {
    expect(bandForWriting(table, "為", ["ため"])).toBe(2);
    expect(bandForWriting(table, "為", ["い"])).toBeNull();
  });

  // Reports #22/#23: くだり (件/条/行) and あや (綾/文) borrowed けん's and ぶん's N3.
  it("does not lend a shared spelling's band to a different word", () => {
    expect(bandForWriting(table, "件", ["くだり"])).toBeNull();
    expect(bandForWriting(table, "文", ["あや"])).toBeNull();
    expect(bandForWriting(table, "文", ["ぶん"])).toBe(3);
  });

  it("takes the easiest band when the entry has several listed readings", () => {
    expect(bandForWriting(table, "何", ["なに", "なん"])).toBe(1);
  });

  it("compares readings across kana scripts", () => {
    expect(bandForWriting(table, "為", ["タメ"])).toBe(2);
  });

  it("matches a kana writing by its spelling — a kana writing is its own reading", () => {
    expect(bandForWriting(table, "あいにく", ["あいにく"])).toBe(3);
    expect(bandForWriting(table, "コンピューター", [])).toBe(2);
  });

  it("is null for an unlisted writing", () => {
    expect(bandForWriting(table, "猫", ["ねこ"])).toBeNull();
  });
});

describe("parseProficiency", () => {
  it("keeps the easiest band for a repeated (surface, reading)", () => {
    expect(parseProficiency("為\tため\t3\n為\tため\t2").get("為")?.get("ため")).toBe(2);
  });

  it("rejects the old two-column format instead of silently levelling nothing", () => {
    expect(() => parseProficiency("為\t2")).toThrow(/malformed/);
  });

  it("parses the committed data file", () => {
    const committed = parseProficiency(readFileSync(PROFICIENCY_URL("ja"), "utf8"));
    expect(committed.size).toBeGreaterThan(7000);
    expect(committed.get("為")?.get("ため")).toBe(2);
    expect(committed.get("文")?.get("ぶん")).toBe(3);
  });
});
