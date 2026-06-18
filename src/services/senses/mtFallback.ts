// =========================================================
// Default sense provider — delegates to the translate edge function.
//
// The edge function now serves JMdict as its PRIMARY provider, so this
// transparently returns ALL of a word's senses (`words`) when JMdict has them,
// and at most one when only the (currently unwired) MT fallback applies — the
// old single-sense "freeze". Because the dictionary decision lives server-side,
// the client registry stays empty and this remains the single entry point; no
// per-pair client provider is needed.
// =========================================================

import { translate } from "../translation";
import type { SenseProvider } from "./provider";

/**
 * OUTPUT: Word[] — every verified sense the edge function persisted (primary
 * first); at most one when only MT applies; [] on no result.
 * CONSTRAINTS: relies on the edge function to cache the senses as verified rows.
 */
export const mtFallbackProvider: SenseProvider = async (
  word,
  sourceLang,
  targetLang
) => {
  const { word: cached, words } = await translate({
    input: word,
    sourceLang,
    targetLang,
  });
  if (words && words.length > 0) return words;
  return cached ? [cached] : [];
};
