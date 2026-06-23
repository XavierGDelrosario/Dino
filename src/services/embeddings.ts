// =========================================================
// Relatedness / "word map" reads (#11) — the semantic axis (distinct from the
// difficulty axis in services/difficulty; never conflate the two).
//
// Thin client over the related_words() RPC: given a JMdict entry (a Word's
// `jmdictEntryId`), return the nearest entries by cosine distance over the
// off-the-shelf embeddings (volleyball terms cluster, legal terms cluster, …).
// The raw vectors stay server-only; this only ever sees derived writing/gloss.
//
// Consumed by #12 (domain-tailored quizzes): expand a pasted text into related
// domain terms, then filter to the user's level (services/difficulty + calibration).
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";

/** A semantically-related dictionary entry (lower distance = more related). */
export interface RelatedWord {
  /** JMdict entry id (maps to a Word's `jmdictEntryId`). */
  entryId: string;
  /** Representative writing (preferred kanji, else kana), or null. */
  writing: string | null;
  /** The entry's primary-sense glosses, joined, or null. */
  gloss: string | null;
  /** Cosine distance 0..2 (0 = identical meaning … 2 = opposite). */
  distance: number;
}

/**
 * The N words most semantically related to a dictionary entry, nearest first.
 * Empty when the entry hasn't been embedded yet (so callers degrade gracefully).
 *
 * OUTPUT: RelatedWord[] (≤ limit), nearest first.
 * CONSTRAINTS: `entryId` is a JMdict entry id (a Word's jmdictEntryId, non-MT rows
 * only); reads are server-side via the SECURITY DEFINER RPC — no raw vectors leak.
 */
export async function relatedWords(params: {
  entryId: string;
  limit?: number;
}): Promise<RelatedWord[]> {
  const { data, error } = await supabase.rpc("related_words", {
    p_entry_id: params.entryId,
    p_limit: params.limit,
  });
  if (error) throw toServiceError(error);
  return (
    (data ?? []) as { entry_id: string; writing: string | null; gloss: string | null; distance: number }[]
  ).map((r) => ({
    entryId: r.entry_id,
    writing: r.writing,
    gloss: r.gloss,
    distance: r.distance,
  }));
}
