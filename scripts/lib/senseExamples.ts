// =========================================================
// The sense-curation corpus file: format, parsing, and its rules — shared by the ingest
// (scripts/ingest-sense-examples.ts), the kuromoji gate (scripts/validate-sense-
// examples.ts) and the regression test that re-runs the gate over the whole file.
//
// PURE + STRICT. This is AUTHORED data, so a malformed line is a mistake to surface,
// never a row to quietly skip: a dropped sentence would look exactly like a sentence
// that was never written, and the coverage number would lie. Every rule here mirrors a
// CHECK constraint in migration 20260752.
//
// FORMAT — tab-separated, one CURATED ROW per line:
//   dictionary_ref <TAB> example <TAB> example_gloss <TAB> definition_source
//     [<TAB> example_reading [<TAB> sense_rank]]
// Blank lines and lines starting '#' are comments. A field may be empty (= NULL).
//
// ‼️ COLUMN 1 IS words.dictionary_ref, not an entry id. It is what the CACHE is unique
// on, so a curated row addresses exactly one cached row — and it is stable in BOTH
// directions, where the old (entry, sense) key only worked in one:
//   JA→EN  `<entryId>:<sensePos>`  — 1283190:0        (JMdict's sense position, still)
//   EN→JA  `<input>:<entryId>`     — changes:5742628
// In the EN→JA direction jmdict_sense_pos is the RANKER'S OUTPUT, so keying on it would
// pin a position the ranker recomputes. See migration 20260752.
//
// The file is per-DIRECTION: ja.tsv is JA→EN, so the language pair is implied rather
// than repeated on every line.
// =========================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TSV_URL = new URL("../../data/sense_examples/ja.tsv", import.meta.url);
export const TSV_PATH = fileURLToPath(TSV_URL);

/** The direction ja.tsv curates. */
export const SOURCE_LANG = "JA";
export const TARGET_LANG = "EN";

/** One curated row, as authored. NFC-normalized; empty fields become null. */
export interface SenseExample {
  /** words.dictionary_ref, lowercased — the cache identity this row curates. */
  dictionaryRef: string;
  /** Japanese sentence demonstrating THIS sense, or null. */
  example: string | null;
  /** English translation of `example`, or null. */
  exampleGloss: string | null;
  /** Monolingual definition in the SOURCE language, or null. */
  definitionSource: string | null;
  /**
   * How the TARGET reads IN THIS SENTENCE. Set only where kuromoji gets it wrong and no
   * rewrite fixes it — 辛い (always read つらい, even in 「カレーが辛い」) and 金 (きん/きむ,
   * never かね). Overrules the analyzer, never the dictionary. NULL = trust kuromoji.
   */
  exampleReading: string | null;
  /**
   * Curated display position among a headword's senses. NULL = keep the default order,
   * which for JA→EN is JMdict's own and for EN→JA is our computed ranking.
   */
  senseRank: number | null;
  /** 1-based line number in the TSV — so an error names the line you have to fix. */
  line: number;
}

export interface ParseIssue {
  line: number;
  message: string;
}

const MIN_COLUMNS = 4;
const MAX_COLUMNS = 6;

/** Kana only — an override written in kanji would defeat its own purpose. */
const KANA_ONLY = /^[ぁ-ゟ゠-ヿー]+$/;

const clean = (s: string): string | null => {
  const v = s.trim().normalize("NFC");
  return v === "" ? null : v;
};

/** JA→EN refs are `<entryId>:<sensePos>`; pull the entry id back out for the gate. */
export function entryIdFromRef(ref: string): string | null {
  const m = /^(\d+):(\d+)$/.exec(ref);
  return m ? m[1] : null;
}

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

    // Lowercased to match curationKeyFor: the EN→JA ref embeds the typed search term,
    // so Car:1323080 and car:1323080 must be one curation, not two.
    const dictionaryRef = (clean(parts[0]) ?? "").toLowerCase();
    if (!dictionaryRef.includes(":")) {
      issues.push({
        line,
        message: `dictionary_ref must look like <entry>:<sense> or <input>:<entry>, got "${parts[0].trim()}"`,
      });
      return;
    }

    const example = clean(parts[1]);
    const exampleGloss = clean(parts[2]);
    const definitionSource = clean(parts[3]);
    const exampleReading = clean(parts[4] ?? "");
    const rankRaw = clean(parts[5] ?? "");

    // Mirrors CHECK curation_has_content. A bare sense_rank counts — reordering is a
    // curation in its own right and owes no sentence.
    if (example === null && definitionSource === null && rankRaw === null) {
      issues.push({
        line,
        message: "row curates nothing — needs an example, a definition, or a sense_rank",
      });
      return;
    }
    if (exampleGloss !== null && example === null) {
      issues.push({ line, message: "example_gloss with no example to translate" });
      return;
    }
    if (exampleReading !== null && !KANA_ONLY.test(exampleReading)) {
      issues.push({ line, message: `example_reading must be kana, got "${exampleReading}"` });
      return;
    }
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

    const first = seen.get(dictionaryRef);
    if (first !== undefined) {
      issues.push({ line, message: `duplicate ref ${dictionaryRef} — already curated on line ${first}` });
      return;
    }
    seen.set(dictionaryRef, line);

    rows.push({ dictionaryRef, example, exampleGloss, definitionSource, exampleReading, senseRank, line });
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
