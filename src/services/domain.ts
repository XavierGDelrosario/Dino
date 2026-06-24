// =========================================================
// Domain expansion (#12) — the differentiator. Turn the words IN a pasted text
// into the broader DOMAIN vocabulary AROUND them, at the user's level: pool the
// word map's neighbours across every content word (so volleyball subtitles surface
// volleyball terms), rank by domain CENTRALITY, drop what's too easy/hard, and feed
// the result to the existing quiz.
//
// Two axes, kept separate (as everywhere): RELATEDNESS comes from the embeddings
// (related_words / services/embeddings); DIFFICULTY from frequency (getDifficulty).
// This module only orchestrates + ranks; turning a candidate into a quizzable Word
// is a lookup the caller does for the final (small) selected set.
// =========================================================

import { relatedWords, type RelatedWord } from "./embeddings";
import { getDifficulty, type LevelValue } from "./difficulty";
import { isExplicitSuggestion } from "./contentSafety";
import type { Word } from "./words/repository";
import { mapLimit } from "../lib/concurrency";

/** A ranked domain-expansion candidate (a related word NOT in the source text). */
export interface DomainCandidate {
  entryId: string;
  /** Representative writing (the lookup key to turn this into a quizzable Word). */
  writing: string;
  gloss: string | null;
  difficulty: LevelValue | null;
  /** How many of the seed words this is related to — domain CENTRALITY. */
  affinity: number;
  /** Best (smallest) cosine distance to any seed. */
  distance: number;
}

const PER_SEED = 12; // neighbours fetched per seed word
const POOL_LIMIT = 20; // final ranked pool size
const LEVEL_WINDOW = 1; // keep within ±1 of the user's level

/** Difficulty of a JA candidate from its frequency — reuses the difficulty facade
 *  (which only reads frequency/override/sourceLang off the Word). */
function difficultyOf(frequency: number | null): LevelValue | null {
  return getDifficulty(
    { frequency, difficultyOverride: null, sourceLang: "JA" } as unknown as Word,
  ).level;
}

/**
 * PURE rank: pool related-word results across all seeds, exclude the seeds
 * themselves (and null-writing rows), rank by domain centrality (affinity = number
 * of seeds a candidate is near) then closeness, and filter to within ±1 of the
 * user's level. The level filter is SKIPPED when userLevel is null (un-calibrated)
 * so the feature still works — it just isn't level-tailored.
 *
 * OUTPUT: DomainCandidate[] (≤ limit), most domain-central first.
 */
export function rankDomainCandidates(
  perSeed: RelatedWord[][],
  seedEntryIds: string[],
  userLevel: LevelValue | null,
  limit: number = POOL_LIMIT,
): DomainCandidate[] {
  const seeds = new Set(seedEntryIds);
  const pool = new Map<string, DomainCandidate>();

  for (const results of perSeed) {
    for (const r of results) {
      if (!r.writing || seeds.has(r.entryId)) continue; // skip null-writing + seed words
      // CONTENT SAFETY: never RECOMMEND an explicit/profane word (still searchable
      // directly). Filters the `stryker→stripper` class out of the word map.
      if (isExplicitSuggestion(r.writing, r.gloss)) continue;
      const existing = pool.get(r.entryId);
      if (existing) {
        existing.affinity += 1;
        existing.distance = Math.min(existing.distance, r.distance);
      } else {
        pool.set(r.entryId, {
          entryId: r.entryId,
          writing: r.writing,
          gloss: r.gloss,
          difficulty: difficultyOf(r.frequency),
          affinity: 1,
          distance: r.distance,
        });
      }
    }
  }

  let candidates = [...pool.values()];
  if (userLevel != null) {
    candidates = candidates.filter(
      (c) => c.difficulty != null && Math.abs(c.difficulty - userLevel) <= LEVEL_WINDOW,
    );
  }
  candidates.sort((a, b) => b.affinity - a.affinity || a.distance - b.distance);
  return candidates.slice(0, Math.max(0, limit));
}

/**
 * Expand seed JMdict entries (a text's content words) into a ranked, level-filtered
 * pool of related DOMAIN words. One related_words call per seed (bounded
 * concurrency); a seed that isn't embedded just contributes nothing.
 *
 * OUTPUT: DomainCandidate[] (most domain-central first), or [] for no seeds.
 * CONSTRAINTS: seedEntryIds are JMdict entry ids (a Word's jmdictEntryId, non-MT).
 */
export async function expandDomain(params: {
  seedEntryIds: string[];
  userLevel: LevelValue | null;
  limit?: number;
}): Promise<DomainCandidate[]> {
  const seeds = [...new Set(params.seedEntryIds)].filter(Boolean);
  if (seeds.length === 0) return [];
  const perSeed = await mapLimit(seeds, 6, (entryId) =>
    relatedWords({ entryId, limit: PER_SEED }).catch(() => [] as RelatedWord[]),
  );
  return rankDomainCandidates(perSeed, seeds, params.userLevel, params.limit ?? POOL_LIMIT);
}
