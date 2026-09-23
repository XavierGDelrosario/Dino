// =========================================================
// Lists service — a user's vocab SUB-lists (the `lists` table).
//
// Sub-lists are optional folders/tags over a user's vocabulary. "ALL" is NOT a
// stored list — a user's whole vocabulary is their `user_words` rows (see
// userWords.ts), so there is no ALL row to create, protect, or delete here. The
// name "ALL" stays reserved so a sub-list can't shadow the virtual one.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { nfcTrim } from "../lib/text";
import { ServiceError, toServiceError } from "./errors";
import type { Database } from "../types/database.types";
import type { LangCode } from "./language";
import { FREQ_BIN_THRESHOLDS_ASC } from "./analyze/summarize";

export interface List {
  listId: string;
  listName: string;
}

// Only the columns this module selects, derived from the generated schema types.
type ListRow = Pick<
  Database["public"]["Tables"]["lists"]["Row"],
  "list_id" | "list_name"
>;

const ALL_LIST_NAME = "ALL";

const toList = (r: ListRow): List => ({
  listId: r.list_id,
  listName: r.list_name,
});

/** Rejects the reserved virtual-list name "ALL" (case-insensitive). */
function assertNotReservedName(name: string): void {
  if (name.toUpperCase() === ALL_LIST_NAME) {
    throw new ServiceError(`"${ALL_LIST_NAME}" is a reserved list name`, "validation");
  }
}

/**
 * A user's sub-lists, alphabetically.
 * OUTPUT: List[] (may be empty).
 * CONSTRAINTS: RLS-scoped to the user's own lists.
 */
export async function listUserLists(userId: string): Promise<List[]> {
  const { data, error } = await supabase
    .from("lists")
    .select<string, ListRow>("list_id, list_name")
    .eq("user_id", userId)
    .order("list_name");
  if (error) throw toServiceError(error);
  return (data ?? []).map(toList);
}

/**
 * Creates a new sub-list for the user.
 * OUTPUT: the new List.
 * CONSTRAINTS: name required (trimmed); rejects the reserved name "ALL".
 */
export async function createList(params: {
  userId: string;
  listName: string;
}): Promise<List> {
  const { userId } = params;
  // NFC so a composed vs decomposed Japanese name can't bypass UNIQUE(user_id,name).
  const name = nfcTrim(params.listName);
  if (!name) throw new ServiceError("List name is required", "validation");
  assertNotReservedName(name);

  const { data, error } = await supabase
    .from("lists")
    .insert({ user_id: userId, list_name: name })
    .select<string, ListRow>("list_id, list_name")
    .single();
  if (error || !data) throw toServiceError(error, "Failed to create list");
  return toList(data);
}

/**
 * Renames a sub-list.
 * OUTPUT: void.
 * CONSTRAINTS: name required; rejects renaming to the reserved name "ALL".
 */
export async function renameList(params: {
  listId: string;
  listName: string;
}): Promise<void> {
  const { listId } = params;
  const name = nfcTrim(params.listName);
  if (!name) throw new ServiceError("List name is required", "validation");
  assertNotReservedName(name);

  const { error } = await supabase
    .from("lists")
    .update({ list_name: name })
    .eq("list_id", listId);
  if (error) throw toServiceError(error);
}

/**
 * Deletes a sub-list. Its `list_words` tags cascade away (schema); the user's
 * `user_words` and their mastery survive — the words stay in the vocabulary.
 *
 * OUTPUT: void.
 * CONSTRAINTS: RLS-scoped to own lists; only the tags are removed.
 */
export async function deleteList(listId: string): Promise<void> {
  const { error } = await supabase.from("lists").delete().eq("list_id", listId);
  if (error) throw toServiceError(error);
}

// ── The lists OVERVIEW (the vertical index page) ────────────────────────────

/** One row of the lists index: a list, or ALL when `listId` is null. */
export interface ListOverview {
  /** null = the virtual ALL list (the whole vocabulary), which has no `lists` row. */
  listId: string | null;
  /** null for ALL — the view supplies the localized label, so it isn't stored. */
  listName: string | null;
  /** When the list was created. Null for ALL (it was never created). */
  createdAt: string | null;
  /** When a word was last filed into it. Null when it holds none. */
  lastWordAddedAt: string | null;
  wordCount: number;
  /** Words per displayed confidence, index 0..5. Always length 6. */
  confidence: number[];
  /** width_bucket index over FREQ_BIN_THRESHOLDS_ASC (or -1 unranked) → count. */
  freq: Record<string, number>;
  /** proficiency_band ordinal (or -1 unranked) → count. */
  band: Record<string, number>;
  /** The list's dominant source language — picks the Difficulty ruler. */
  mainLang: LangCode | null;
}

/** 0..5 — the six display-confidence buckets the histogram is keyed on. */
const CONFIDENCE_BUCKETS = 6;

/** A JSONB histogram → a plain count map, tolerating null and non-numeric values
 *  (an older function, a hand-written row) rather than letting a NaN reach a chart. */
function countMap(v: unknown): Record<string, number> {
  if (v == null || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const c = Number(n);
    if (Number.isFinite(c) && c > 0) out[k] = c;
  }
  return out;
}

/** PostgREST's "no such function" — the database predates migration 20260773. */
const isMissingFunction = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST202";

/** Latched by the first miss, so an un-migrated database costs ONE failed RPC per
 *  session rather than one per visit to the tab. A reload re-probes, so applying the
 *  migration heals the client with no redeploy — same shape as userWords.ts's
 *  optional-column probe. */
let overviewAvailable = true;

/** TEST SEAM: the latch is module-global, so without a reset one spec's downgrade
 *  leaks into the next. */
export function __resetListOverviewProbe(): void {
  overviewAvailable = true;
}

/**
 * Every list plus ALL, with size, timestamps and a confidence histogram.
 *
 * OUTPUT: unordered (the page sorts client-side, so changing the axis costs no round
 * trip); ALL is the row with `listId === null`. **NULL when this database has no
 * list_overview() yet** — see below.
 * CONSTRAINTS: ONE query that loads NO WORDS — the counts and the histogram are SQL
 * aggregates, so the page costs the same at 50 saved words and at 50,000. The
 * histogram uses the LIVE display confidence, matching every other read surface.
 *
 * ‼️ RETURNS NULL RATHER THAN THROWING when the function is absent. The client and the
 * database deploy separately, so there is always a window where a build that calls this
 * is live against a database that has not taken migration 20260773 — and the overview is
 * the Lists tab's LANDING screen, so a throw there is not a degraded feature, it is the
 * whole tab replaced by an error for every user. Null means "this database can't answer
 * that", and the view falls back to the chip row it has always had.
 */
export async function getListOverview(): Promise<ListOverview[] | null> {
  if (!overviewAvailable) return null;
  // The BINS TRAVEL WITH THE CALL. They are defined once, client-side, in
  // services/analyze/summarize.ts; SQL applies them and never owns them, so re-tuning
  // the bar is a one-file change and there is no second copy to drift.
  const { data, error } = await supabase.rpc("list_overview", {
    p_freq_bins: FREQ_BIN_THRESHOLDS_ASC,
  });
  if (isMissingFunction(error)) {
    overviewAvailable = false;
    console.warn(
      "[lists] this database predates migration 20260773; " +
        "falling back to the list chips (no overview).",
    );
    return null;
  }
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    listId: r.list_id,
    listName: r.list_name,
    createdAt: r.created_at,
    lastWordAddedAt: r.last_word_added_at,
    wordCount: Number(r.word_count ?? 0),
    // Padded rather than trusted: a shorter array (an older function, a bucket change)
    // would otherwise render as an undefined-width bar rather than an empty one.
    confidence: Array.from(
      { length: CONFIDENCE_BUCKETS },
      (_, i) => Number(r.confidence?.[i] ?? 0),
    ),
    // Histograms arrive as JSONB objects so neither side needs a fixed bucket count;
    // an absent key simply means nothing fell there.
    freq: countMap(r.freq_counts),
    band: countMap(r.band_counts),
    mainLang: (r.main_lang as LangCode | null) ?? null,
  }));
}
