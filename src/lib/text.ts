// Unicode normalization helpers. User input is NFC-normalized at every boundary
// (cache-key correctness, esp. Japanese — combining vs precomposed forms must not
// fork rows). Centralized here so the convention is one call, not an inline
// `.normalize("NFC")` scattered across services.

/** NFC-normalize (no trimming) — for already-tokenized text (lemmas, cache keys). */
export const nfc = (s: string): string => s.normalize("NFC");

/** Trim + NFC-normalize — the standard treatment for raw user input at a boundary. */
export const nfcTrim = (s: string): string => s.trim().normalize("NFC");

// Katakana, the long-vowel mark ー, iteration marks, and the ・ that joins the parts
// of a foreign name (イビチャ・オシム). Halfwidth katakana included so ﾆｭｰｽ counts too.
const KATAKANA_ONLY = /^[゠-ヿｦ-ﾟー]+$/u;

/**
 * Is every character katakana (the script Japanese writes foreign words and names
 * in)? Used to single out the class of token that is overwhelmingly a name or a
 * brand when the dictionary has no entry for it. `false` for empty text and for
 * any mixed-script surface. PURE.
 */
export const isKatakanaOnly = (s: string): boolean => s.length > 0 && KATAKANA_ONLY.test(s);
