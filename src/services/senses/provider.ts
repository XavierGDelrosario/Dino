// =========================================================
// Sense provider contract.
//
// A SenseProvider returns ALL known senses of a single word for a language
// pair, persisting them to the words cache. Which provider serves a given pair
// is decided by registry.ts (keyed on language). The default provider delegates
// to the translate edge function: JMdict-backed pairs return every sense; the
// (unimplemented) MT fallback would return at most one.
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "../words/repository";

export type SenseProvider = (
  word: string,
  sourceLang: LangCode,
  targetLang: LangCode
) => Promise<Word[]>;
