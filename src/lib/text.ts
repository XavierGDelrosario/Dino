// Unicode normalization helpers. User input is NFC-normalized at every boundary
// (cache-key correctness, esp. Japanese — combining vs precomposed forms must not
// fork rows). Centralized here so the convention is one call, not an inline
// `.normalize("NFC")` scattered across services.

/** NFC-normalize (no trimming) — for already-tokenized text (lemmas, cache keys). */
export const nfc = (s: string): string => s.normalize("NFC");

/** Trim + NFC-normalize — the standard treatment for raw user input at a boundary. */
export const nfcTrim = (s: string): string => s.trim().normalize("NFC");

/**
 * Katakana → hiragana, so one comparison covers both scripts. Readings reach us in
 * both: kuromoji emits katakana (analyze.ts folds it to hiragana), while a JMdict
 * kana headword keeps whatever script the entry uses — コーヒー stays katakana. So
 * comparing a token's reading against a sense's reading needs both sides folded, or
 * every katakana word silently fails to match.
 *
 * NOTE: two private copies of this fold already exist (services/language/analyze.ts,
 * services/contentSafety.ts). This is the canonical one for new callers; collapsing
 * those two into it is a tidy-up, deliberately not done here to keep this change off
 * files being edited elsewhere.
 */
export const foldKana = (s: string): string =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

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
