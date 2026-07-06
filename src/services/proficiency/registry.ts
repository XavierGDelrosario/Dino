// =========================================================
// Proficiency framework registry — routes a language to its curated scale.
//
// Mirrors services/difficulty/registry.ts and services/language/registry.ts: a
// per-language entry with a null default. This IS the seam that keeps proficiency
// from sprawling into a "JLPT feature" then an "HSK feature": every framework is
// one entry here + one ingest wordlist, and nothing downstream (badge, level
// picker, quiz) knows which framework a word came from.
//
// Today: JA → JLPT, EN → CEFR. A language with no curated scale returns null (the
// word simply has no proficiency label). Adding one is a single line + a
// data/proficiency/<lang>.tsv.
// =========================================================

import type { LangCode } from "../language";
import { type ProficiencyFramework, bandsFromLabels } from "./framework";

// JLPT (Japanese) — 5 bands. Labels count DOWN (N5 easiest → N1 hardest), so we
// list them easiest-first: value 1 = N5 … value 5 = N1 (ascending = harder).
const JLPT: ProficiencyFramework = {
  code: "JLPT",
  name: "JLPT",
  bands: bandsFromLabels(["N5", "N4", "N3", "N2", "N1"]),
};

// CEFR (English, and any European language) — 6 bands. A1 easiest → C2 hardest.
const CEFR: ProficiencyFramework = {
  code: "CEFR",
  name: "CEFR",
  bands: bandsFromLabels(["A1", "A2", "B1", "B2", "C1", "C2"]),
};

const FRAMEWORKS: Partial<Record<LangCode, ProficiencyFramework>> = {
  JA: JLPT,
  EN: CEFR,
};

/** The curated proficiency framework for a language, or null if it has none. */
export function resolveFramework(lang: LangCode): ProficiencyFramework | null {
  return FRAMEWORKS[lang] ?? null;
}
