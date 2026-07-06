// Unicode normalization helpers. User input is NFC-normalized at every boundary
// (cache-key correctness, esp. Japanese — combining vs precomposed forms must not
// fork rows). Centralized here so the convention is one call, not an inline
// `.normalize("NFC")` scattered across services.

/** NFC-normalize (no trimming) — for already-tokenized text (lemmas, cache keys). */
export const nfc = (s: string): string => s.normalize("NFC");

/** Trim + NFC-normalize — the standard treatment for raw user input at a boundary. */
export const nfcTrim = (s: string): string => s.trim().normalize("NFC");
