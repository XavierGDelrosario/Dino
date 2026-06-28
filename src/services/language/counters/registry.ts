// Per-language counter-resolver registry — the swap seam. Add a language = one entry
// (Chinese measure words, Korean counters, …); unregistered languages return null and
// the reader keeps the morphological engine's reading unchanged.
import type { LangCode } from "../registry";
import type { CounterResolver } from "./types";
import { japaneseCounterResolver } from "./japanese";

const RESOLVERS: Partial<Record<string, CounterResolver>> = {
  JA: japaneseCounterResolver,
};

export function getCounterResolver(lang: LangCode): CounterResolver | null {
  return RESOLVERS[lang.toUpperCase()] ?? null;
}
