// =========================================================
// Sense provider registry — routes a language pair to its dictionary.
//
// EMPTY for now: every pair falls back to MT (single sense), so the app runs
// unchanged. To add real multi-sense lookup, register a provider for a pair —
// that one entry IS the whole "pick a dictionary" decision (Jisho/JMdict/...).
// The decision is deferred; the seam is ready.
// =========================================================

import type { LangCode } from "../language";
import type { SenseProvider } from "./provider";
import { mtFallbackProvider } from "./mtFallback";

interface SenseProviderEntry {
  /** True if this provider handles the given source -> target pair. */
  supports(source: LangCode, target: LangCode): boolean;
  provider: SenseProvider;
}

// Register real dictionary providers here, e.g.:
//   { supports: (s, t) => (s === "JA" && t === "EN") || (s === "EN" && t === "JA"),
//     provider: jmdictProvider },
const SENSE_PROVIDERS: SenseProviderEntry[] = [];

/**
 * Picks the sense provider for a language pair.
 * OUTPUT: the matching SenseProvider, or the MT fallback.
 * CONSTRAINTS: registry is empty → always the MT fallback (one sense, the
 * "freeze" stands) until a real dictionary is registered.
 */
export function resolveSenseProvider(
  source: LangCode,
  target: LangCode
): SenseProvider {
  return (
    SENSE_PROVIDERS.find((e) => e.supports(source, target))?.provider ??
    mtFallbackProvider
  );
}
