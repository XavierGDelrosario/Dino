// The sense-example corpus, guarded two ways:
//   1. the FORMAT rules (pure, fast) — every rule here mirrors a CHECK in 20260750, so
//      a bad line fails at review time instead of halfway through an INSERT;
//   2. the kuromoji GATE re-run over the whole committed file — the regression half.
//      Once a sentence is in ja.tsv it has to keep parsing, so a kuromoji upgrade or a
//      JMdict re-ingest that breaks one is caught here rather than in the reader.
//
// The gate's dictionary-dependent checks (target token, authoritative reading, orphan
// words) need Postgres and so live in the CLI (`npx tsx scripts/validate-sense-examples.ts`).
// What runs here is everything that needs only the analyzer — which is what makes it
// safe for the default green gate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSenseExamples, TSV_URL } from "../../scripts/lib/senseExamples";
import { assertRealAnalyzer, checkField } from "../../scripts/validate-sense-examples";

// Building the tokenizer loads the ~12MB IPADIC on first use.
const KUROMOJI_TIMEOUT = 60_000;

const corpus = (() => {
  try {
    return readFileSync(TSV_URL, "utf8");
  } catch {
    return null; // the corpus is generated in batches; "not written yet" is legitimate
  }
})();

describe("sense-example corpus — format", () => {
  it("parses with no malformed lines", () => {
    if (corpus === null) return;
    const { issues } = parseSenseExamples(corpus);
    expect(issues).toEqual([]);
  });

  it("rejects the shapes the DB constraints reject", () => {
    const { rows, issues } = parseSenseExamples(
      [
        "1234:0\t例文だ。\tAn example.\t定義。", // valid
        "1234:1\t\t\t", // curates nothing
        "1234:2\t\tA gloss with no example\t", // gloss without example
        "1234:0\t重複。\t\t定義。", // duplicate ref (line 1)
        "1234\t例文だ。\t\t定義。", // ref with no ':' separator
        "1234:5\t例文だ。\t\t定義。\t\t-1", // negative sense_rank
        "1234:9\tmissing a column", // wrong field count
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(issues[2].message).toMatch(/duplicate/);
  });

  it("treats blank lines and # comments as absent", () => {
    const { rows, issues } = parseSenseExamples("# a note\n\n1234:0\t例文だ。\t\t定義。\n");
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(3); // the line number still points at the real file line
  });

  it("normalizes to NFC and turns empty fields into null", () => {
    // Decomposed が (か + combining dakuten) must land as the composed form, or the
    // same sentence typed two ways would be two different strings in the DB.
    const { rows } = parseSenseExamples("1234:0\tこれがある。\t\t定義。");
    expect(rows[0].example).toBe("これがある。");
    expect(rows[0].exampleGloss).toBeNull();
  });
});

describe("sense-example corpus — kuromoji gate (regression)", () => {
  it(
    "every committed sentence and definition still parses cleanly",
    async () => {
      if (corpus === null) return;
      await assertRealAnalyzer(); // a silent Segmenter fallback would pass this vacuously

      const { rows } = parseSenseExamples(corpus);
      expect(rows.length).toBeGreaterThan(0);

      const failures = [];
      for (const row of rows) {
        // Offline mode: no headword, no dictionary probe — offsets are what this half
        // proves, and offsets are what the reader's highlight ranges depend on.
        if (row.example) failures.push(...(await checkField(row, "example", row.example, null, null)));
        if (row.definitionSource) {
          failures.push(...(await checkField(row, "definition", row.definitionSource, null, null)));
        }
      }
      expect(failures).toEqual([]);
    },
    KUROMOJI_TIMEOUT,
  );
});
