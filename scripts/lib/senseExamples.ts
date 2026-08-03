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
//     [<TAB> example_reading [<TAB> sense_rank]]
// Blank lines and lines starting '#' are comments. A field may be empty (= NULL).
//
// The last two are CURATION (migration 20260751) and are optional trailing fields, so
// the hundreds of lines written before they existed stay valid as-is — a format change
// that forced a rewrite of the whole corpus would be a change that risks it.
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
  /**
   * How the TARGET reads IN THIS SENTENCE. Set only where kuromoji gets it wrong and no
   * rewrite fixes it — 辛い (always read つらい, even in 「カレーが辛い」) and 金 (きん/きむ,
   * never かね). Overrules the analyzer when rendering furigana. NULL = trust kuromoji.
   */
  exampleReading: string | null;
  /**
   * Curated display position for this sense among its headword's senses. NULL = keep
   * JMdict's own order. Never touches `jmdict_sense_pos`, which is cache identity.
   */
  senseRank: number | null;
  /** 1-based line number in the TSV — so an error names the line you have to fix. */
  line: number;
}

export interface ParseIssue {
  line: number;
  message: string;
}

const MIN_COLUMNS = 5;
const MAX_COLUMNS = 7;

/** Kana only — an override written in kanji would defeat its own purpose. */
const KANA_ONLY = /^[\u3041-\u309F\u30A0-\u30FF\u30FC]+$/;

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
    if (parts.length < MIN_COLUMNS || parts.length > MAX_COLUMNS) {
      issues.push({
        line,
        message: `expected ${MIN_COLUMNS}-${MAX_COLUMNS} tab-separated fields, found ${parts.length}`,
      });
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
    const exampleReading = clean(parts[5] ?? "");
    const rankRaw = clean(parts[6] ?? "");

    // Mirrors CHECK sense_example_has_content: absence is "no row", not an empty one.
    // A bare sense_rank counts — reordering a sense is a curation in its own right and
    // owes no sentence (see 20260751).
    if (example === null && definitionJa === null && rankRaw === null) {
      issues.push({
        line,
        message: "row annotates nothing — needs an example, a definition, or a sense_rank",
      });
      return;
    }
    // Mirrors CHECK sense_example_gloss_needs_example.
    if (exampleGloss !== null && example === null) {
      issues.push({ line, message: "example_gloss with no example to translate" });
      return;
    }

    if (exampleReading !== null && !KANA_ONLY.test(exampleReading)) {
      issues.push({ line, message: `example_reading must be kana, got "${exampleReading}"` });
      return;
    }
    // Mirrors CHECK sense_example_reading_needs_example.
    if (exampleReading !== null && example === null) {
      issues.push({ line, message: "example_reading with no example to annotate" });
      return;
    }
    let senseRank: number | null = null;
    if (rankRaw !== null) {
      senseRank = Number(rankRaw);
      if (!Number.isInteger(senseRank) || senseRank < 0) {
        issues.push({ line, message: `sense_rank must be a non-negative integer, got "${rankRaw}"` });
        return;
      }
    }

    const key = `${entryId}:${sensePos}`;
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({ line, message: `duplicate sense ${key} — already defined on line ${first}` });
      return;
    }
    seen.set(key, line);

    rows.push({ entryId, sensePos, example, exampleGloss, definitionJa, exampleReading, senseRank, line });
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
