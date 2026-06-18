// =========================================================
// Sense provider registry — routes a language pair to its dictionary.
//
// INTENTIONALLY EMPTY: the "pick a dictionary" decision now lives SERVER-SIDE.
// The translate edge function serves JMdict as its primary provider, so the
// default fallback (mtFallbackProvider → the edge function) already returns the
// full multi-sense set for JMdict-backed pairs. A client-side per-pair provider
// would duplicate routing the server already owns, so we keep this empty.
//
// The seam still exists for a pair that needs CLIENT-side sense logic the edge
// function can't serve — register it below; otherwise leave it empty.
// =========================================================

import type { LangCode } from "../language";
import type { SenseProvider } from "./provider";
import { mtFallbackProvider } from "./mtFallback";

interface SenseProviderEntry {
  /** True if this provider handles the given source -> target pair. */
  supports(source: LangCode, target: LangCode): boolean;
  provider: SenseProvider;
}

// Register a CLIENT-side provider here only if a pair needs sense logic the edge
// function can't serve. JMdict is served server-side, so this stays empty.
const SENSE_PROVIDERS: SenseProviderEntry[] = [];

/**
 * Picks the sense provider for a language pair.
 * OUTPUT: the matching SenseProvider, or the default (edge-function) fallback.
 * CONSTRAINTS: registry is empty → always the default fallback, which delegates
 * to the translate edge function (JMdict-backed → full multi-sense; MT → one).
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
