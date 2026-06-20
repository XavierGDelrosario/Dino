// =========================================================
// Lists service — a user's vocab SUB-lists (the `lists` table).
//
// Sub-lists are optional folders/tags over a user's vocabulary. "ALL" is NOT a
// stored list — a user's whole vocabulary is their `user_words` rows (see
// userWords.ts), so there is no ALL row to create, protect, or delete here. The
// name "ALL" stays reserved so a sub-list can't shadow the virtual one.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { ServiceError, toServiceError } from "./errors";
import type { Database } from "../types/database.types";

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
  const name = params.listName.trim();
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
  const name = params.listName.trim();
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
