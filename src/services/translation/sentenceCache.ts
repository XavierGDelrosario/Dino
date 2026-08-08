// =========================================================
// Sentence gloss cache — pay for a sentence ONCE per session.
//
// The reader can buy English two ways now: tap a sentence's punctuation for that
// one line, or press "Show translation" for the whole text. Without a shared cache
// those two paths bill for the same sentence twice — tap three sentences, then
// press the toggle, and the toggle re-sends all three.
//
// So both go through `glossSentences`, which answers from the cache and requests
// ONLY the misses. A whole-paragraph press after tapping is therefore cheaper than
// it would have been, never more expensive.
//
// Content-addressed on purpose: the key is the SENTENCE plus its language pair,
// never the document it came from. The same line said in two videos is one entry,
// and nothing here can reconstruct a source text — which is also what keeps this
// shape viable for the shared server-side cache in docs/TODO.md.
//
// In-memory and per-session (a Map, cleared on reload), matching services/words/
// cache.ts. Persisting it is a later decision, not a different design.
// =========================================================

import { translateSegments } from "./client";
import type { LangCode } from "../language";
import { nfc } from "../../lib/text";

const cache = new Map<string, string>();

const keyOf = (text: string, source: LangCode, target: LangCode) =>
  `${source}|${target}|${nfc(text.trim())}`;

/** The gloss for a sentence, or undefined if it hasn't been bought yet. PURE read. */
export function getCachedGloss(text: string, source: LangCode, target: LangCode): string | undefined {
  return cache.get(keyOf(text, source, target));
}

/** Remember a gloss (also used to seed the cache from a paragraph result). */
export function setCachedGloss(text: string, source: LangCode, target: LangCode, gloss: string): void {
  if (text.trim() && gloss) cache.set(keyOf(text, source, target), gloss);
}

/** Test seam — the cache is module-global, so specs must be able to reset it. */
export function __clearGlossCache(): void {
  cache.clear();
}

/**
 * Glosses for `segments`, index-aligned with the input. Cached sentences cost
 * nothing; the rest go out in ONE request (the edge dedupes repeats within it too).
 *
 * OUTPUT: one gloss per input sentence — null where translation failed or returned
 * nothing. Never throws for a partial failure: the caller shows what it has.
 */
export async function glossSentences({
  segments,
  sourceLang,
  targetLang,
}: {
  segments: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<(string | null)[]> {
  const out: (string | null)[] = segments.map(
    (s) => getCachedGloss(s, sourceLang, targetLang) ?? null,
  );
  // Ask only for what we don't hold, and only once per distinct sentence — a
  // repeated line in the same paragraph is one segment on the wire.
  const missing: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    if (out[i] !== null) continue;
    const key = keyOf(segments[i], sourceLang, targetLang);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(segments[i]);
  }
  if (missing.length === 0) return out;

  const fetched = await translateSegments({ segments: missing, sourceLang, targetLang });
  missing.forEach((text, i) => {
    const gloss = fetched[i];
    if (gloss) setCachedGloss(text, sourceLang, targetLang, gloss);
  });
  // Re-read through the cache so repeats of the same sentence all get filled.
  return segments.map((s, i) => out[i] ?? getCachedGloss(s, sourceLang, targetLang) ?? null);
}
