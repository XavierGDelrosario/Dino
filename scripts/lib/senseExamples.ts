// =========================================================
// The sense-example corpus file: format, parsing, and its rules — shared by the
// ingest (scripts/ingest-sense-examples.ts), the kuromoji gate
// (scripts/validate-sense-examples.ts) and the regression test that re-runs the gate
// over the whole file (tests/scripts/senseExamples.test.ts).
//
// PURE + STRICT. This is AUTHORED data, so a malformed line is a mistake to surface,
// never a row to quietly skip: a dropped sentence would look exactly like a sentence
// that was never written, and the coverage number would lie. Every rule here mirrors a
// CHECK constraint in migration 20260750, so the file fails at the gate rather than
// halfway through an INSERT.
//
// FORMAT — tab-separated, one SENSE per line:
//   entry_id <TAB> sense_pos <TAB> example <TAB> example_gloss <TAB> definition_ja
// Blank lines and lines starting '#' are comments. A field may be empty (= NULL).
// =========================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TSV_URL = new URL("../../data/sense_examples/ja.tsv", import.meta.url);
export const TSV_PATH = fileURLToPath(TSV_URL);

/** One sense's enrichment, as authored. NFC-normalized; empty fields become null. */
export interface SenseExample {
  /** JMdict ent_seq of the entry this sense belongs to. */
  entryId: string;
  /** The sense's own position in that entry (0 = primary) — jmdict_lookup's s.position. */
  sensePos: number;
  /** Japanese sentence demonstrating THIS sense, or null. */
  example: string | null;
  /** English translation of `example`, or null. */
  exampleGloss: string | null;
  /** Monolingual Japanese definition of THIS sense, or null. */
  definitionJa: string | null;
  /** 1-based line number in the TSV — so an error names the line you have to fix. */
  line: number;
}

export interface ParseIssue {
  line: number;
  message: string;
}

const COLUMNS = 5;

const clean = (s: string): string | null => {
  const v = s.trim().normalize("NFC");
  return v === "" ? null : v;
};

/**
 * Parse the corpus text. PURE.
 *
 * OUTPUT: the rows that are well-formed, plus an issue per line that is not. Callers
 * decide the severity — the ingest refuses to run with any issue, while the validator
 * reports them all at once so a whole batch can be fixed in one pass.
 */
export function parseSenseExamples(text: string): { rows: SenseExample[]; issues: ParseIssue[] } {
  const rows: SenseExample[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Map<string, number>();

  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    // \r so a file that picked up CRLF endings doesn't fail every definition on a
    // trailing carriage return.
    const stripped = raw.replace(/\r$/, "");
    if (stripped.trim() === "" || stripped.startsWith("#")) return;

    const parts = stripped.split("\t");
    if (parts.length !== COLUMNS) {
      issues.push({ line, message: `expected ${COLUMNS} tab-separated fields, found ${parts.length}` });
      return;
    }

    const entryId = parts[0].trim();
    if (!/^\d+$/.test(entryId)) {
      issues.push({ line, message: `entry_id must be a JMdict ent_seq (digits), got "${entryId}"` });
      return;
    }

    const sensePos = Number(parts[1].trim());
    if (!Number.isInteger(sensePos) || sensePos < 0) {
      issues.push({ line, message: `sense_pos must be a non-negative integer, got "${parts[1].trim()}"` });
      return;
    }

    const example = clean(parts[2]);
    const exampleGloss = clean(parts[3]);
    const definitionJa = clean(parts[4]);

    // Mirrors CHECK sense_example_has_content: absence is "no row", not an empty one.
    if (example === null && definitionJa === null) {
      issues.push({ line, message: "row annotates nothing — needs an example or a definition" });
      return;
    }
    // Mirrors CHECK sense_example_gloss_needs_example.
    if (exampleGloss !== null && example === null) {
      issues.push({ line, message: "example_gloss with no example to translate" });
      return;
    }

    const key = `${entryId}:${sensePos}`;
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({ line, message: `duplicate sense ${key} — already defined on line ${first}` });
      return;
    }
    seen.set(key, line);

    rows.push({ entryId, sensePos, example, exampleGloss, definitionJa, line });
  });

  return { rows, issues };
}

/**
 * Read + parse the committed corpus, THROWING on any malformed line.
 *
 * A missing file is not an error: the corpus is generated in batches, so "no file yet"
 * is a legitimate state that yields zero rows (the ingest turns that into its own,
 * clearer refusal rather than truncating a populated table).
 */
export function readSenseExamples(): SenseExample[] {
  let text: string;
  try {
    text = readFileSync(TSV_URL, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const { rows, issues } = parseSenseExamples(text);
  if (issues.length > 0) {
    const detail = issues.map((i) => `  line ${i.line}: ${i.message}`).join("\n");
    throw new Error(`${TSV_PATH} has ${issues.length} malformed line(s):\n${detail}`);
  }
  return rows;
}
