// =========================================================
// Sense provider contract.
//
// A SenseProvider returns ALL known senses of a single word for a language
// pair, persisting them to the words cache. Which provider serves a given pair
// is decided by registry.ts (keyed on language). A real dictionary returns
// every sense; the MT fallback returns one.
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "../words/repository";

export type SenseProvider = (
  word: string,
  sourceLang: LangCode,
  targetLang: LangCode
) => Promise<Word[]>;
