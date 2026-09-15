// =========================================================
// The JLPT band file and the rule that places a band on a JMdict writing — shared by
// the ingest (scripts/ingest-jmdict.ts), the in-place correction for an already-loaded
// database (scripts/apply-proficiency-bands.ts) and the unit tests. One rule, one place:
// the two scripts must never disagree about which writing is levelled.
//
// FORMAT (data/proficiency/ja.tsv, built by scripts/build-proficiency.py):
//   surface <TAB> reading <TAB> band
// one line per (surface, reading); band ascending = harder (N5 → 1 … N1 → 5).
//
// WHY THE READING. The JLPT list levels a WORD, and a kanji spelling is shared by many
// words. It used to be joined by surface alone, so every JMdict entry written 為 took
// ため's N4 — including 為 read い, "the second string of a koto", which the Learn tab
// then dealt as an N4 card (quality report #24). Same for あや (綾/文, levelled by 文 read
// ぶん) and くだり (件/条/行, levelled by 件 read けん). Measured on prod 2026-09-15:
// 1,040 kanji rows across 980 entries carried a band listed for a different reading.
//
// THE RULE:
//   · a KANJI writing takes the band only if its entry has a kana reading the list
//     gives for that spelling (easiest such band wins);
//   · a KANA writing is its own reading, so it matches by surface as before.
// =========================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROFICIENCY_URL = (lang: string) =>
  new URL(`../../data/proficiency/${lang}.tsv`, import.meta.url);
export const proficiencyPath = (lang: string) => fileURLToPath(PROFICIENCY_URL(lang));

const nfc = (s: string) => s.normalize("NFC");

/** Katakana → hiragana, so a reading compares equal however either side spelled it. */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const HAS_KANJI = /\p{Script=Han}/u;

/** surface → (hiragana reading → easiest band). */
export type ProficiencyTable = Map<string, Map<string, number>>;

export function parseProficiency(raw: string): ProficiencyTable {
  const table: ProficiencyTable = new Map();
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [surface, reading, bandText] = line.split("\t");
    const band = Number(bandText);
    if (!surface || !reading || !Number.isInteger(band)) {
      throw new Error(`malformed proficiency line (want surface<TAB>reading<TAB>band): ${line}`);
    }
    const key = nfc(surface);
    const readings = table.get(key) ?? new Map<string, number>();
    const r = toHiragana(nfc(reading));
    const prev = readings.get(r);
    if (prev === undefined || band < prev) readings.set(r, band);
    table.set(key, readings);
  }
  return table;
}

/** The table for `lang`, or an empty one (with a warning) when no file exists. */
export function loadProficiency(lang: string): ProficiencyTable {
  let raw: string;
  try {
    raw = readFileSync(PROFICIENCY_URL(lang), "utf8");
  } catch {
    console.warn(
      `No proficiency file for '${lang}' (data/proficiency/${lang}.tsv) — bands will be NULL. ` +
        `Generate it with: scripts/build-proficiency.py <src-dir> --lang ${lang}`,
    );
    return new Map();
  }
  return parseProficiency(raw);
}

/**
 * The band for one JMdict writing, or null.
 *
 * @param surface      the writing (a jmdict_kanji or jmdict_kana text)
 * @param entryReadings every kana reading of the writing's ENTRY
 */
export function bandForWriting(
  table: ProficiencyTable,
  surface: string,
  entryReadings: readonly string[],
): number | null {
  const listed = table.get(nfc(surface));
  if (!listed) return null;
  // A kana writing IS a reading, so the spelling match is the whole test.
  const candidates = HAS_KANJI.test(surface) ? entryReadings.map((r) => toHiragana(nfc(r))) : [...listed.keys()];
  let best: number | null = null;
  for (const r of candidates) {
    const band = listed.get(r);
    if (band !== undefined && (best === null || band < best)) best = band;
  }
  return best;
}
