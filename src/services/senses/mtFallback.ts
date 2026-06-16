// =========================================================
// MT fallback sense provider.
//
// Used for any language pair with no registered dictionary. Machine translation
// returns ONE sense, so a word cached through here is frozen at a single meaning
// — the known multi-sense "freeze". Registering a real dictionary provider in
// registry.ts fixes this per language pair.
// =========================================================

import { translate } from "../translation";
import type { SenseProvider } from "./provider";

/**
 * OUTPUT: Word[] — at most one sense (the MT result), or [] on no result.
 * CONSTRAINTS: single-sense only (the freeze); relies on the MT edge function
 * to cache the word as a verified row.
 */
export const mtFallbackProvider: SenseProvider = async (
  word,
  sourceLang,
  targetLang
) => {
  const { word: cached } = await translate({
    input: word,
    sourceLang,
    targetLang,
  });
  return cached ? [cached] : [];
};
