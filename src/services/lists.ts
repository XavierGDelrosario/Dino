// =========================================================
// Lists service — a user's vocab folders (the `lists` table).
//
// Every user has a reserved "ALL" list that holds every word they've saved;
// it is created on demand and cannot be renamed or deleted (it backs the
// "every saved word is in ALL" invariant). All other lists are user-managed.
// =========================================================

import { supabase } from "../config/supabaseClient";

export interface List {
  listId: string;
  listName: string;
}

interface ListRow {
  list_id: string;
  list_name: string;
}

const ALL_LIST_NAME = "ALL";

const toList = (r: ListRow): List => ({
  listId: r.list_id,
  listName: r.list_name,
});

function assertNotReservedName(name: string): void {
  if (name.toUpperCase() === ALL_LIST_NAME) {
    throw new Error(`"${ALL_LIST_NAME}" is a reserved list name`);
  }
}

/** Throws if `listId` is the user's reserved ALL list (not user-editable). */
async function assertEditable(listId: string): Promise<void> {
  const { data, error } = await supabase
    .from("lists")
    .select("list_name")
    .eq("list_id", listId)
    .single();
  if (error) throw error;
  if (data?.list_name === ALL_LIST_NAME) {
    throw new Error("The ALL list cannot be renamed or deleted");
  }
}

/**
 * Returns the user's ALL list id, creating it if it doesn't exist yet.
 * OUTPUT: the ALL list id (string).
 * CONSTRAINTS: idempotent via UNIQUE(user_id, list_name); ALL is reserved.
 */
export async function getOrCreateAllListId(userId: string): Promise<string> {
  const { data: existing, error } = await supabase
    .from("lists")
    .select("list_id")
    .eq("user_id", userId)
    .eq("list_name", ALL_LIST_NAME)
    .maybeSingle();
  if (error) throw error;
  if (existing?.list_id) return existing.list_id;

  // Idempotent thanks to UNIQUE (user_id, list_name).
  const { data: inserted, error: insertError } = await supabase
    .from("lists")
    .upsert(
      { user_id: userId, list_name: ALL_LIST_NAME },
      { onConflict: "user_id,list_name" }
    )
    .select("list_id")
    .single();
  if (insertError || !inserted) {
    throw insertError ?? new Error("Failed to create ALL list");
  }
  return inserted.list_id;
}

/**
 * All of a user's lists, ready for a dropdown: ALL first (sensible default),
 * then the rest alphabetically. Each item is { listId, listName }.
 *
 * OUTPUT: List[] — ALL first, then alphabetical.
 * CONSTRAINTS: RLS-scoped to the user's own lists.
 */
export async function listUserLists(userId: string): Promise<List[]> {
  const { data, error } = await supabase
    .from("lists")
    .select<string, ListRow>("list_id, list_name")
    .eq("user_id", userId)
    .order("list_name");
  if (error) throw error;

  const lists = (data ?? []).map(toList);
  lists.sort((a, b) =>
    a.listName === ALL_LIST_NAME ? -1 : b.listName === ALL_LIST_NAME ? 1 : 0
  );
  return lists;
}

/**
 * Creates a new (non-reserved) list for the user.
 * OUTPUT: the new List.
 * CONSTRAINTS: name required (trimmed); rejects the reserved name "ALL".
 */
export async function createList(params: {
  userId: string;
  listName: string;
}): Promise<List> {
  const { userId } = params;
  const name = params.listName.trim();
  if (!name) throw new Error("List name is required");
  assertNotReservedName(name);

  const { data, error } = await supabase
    .from("lists")
    .insert({ user_id: userId, list_name: name })
    .select<string, ListRow>("list_id, list_name")
    .single();
  if (error || !data) throw error ?? new Error("Failed to create list");
  return toList(data);
}

/**
 * Renames a list.
 * OUTPUT: void.
 * CONSTRAINTS: rejects renaming to "ALL" and refuses the ALL list itself.
 */
export async function renameList(params: {
  listId: string;
  listName: string;
}): Promise<void> {
  const { listId } = params;
  const name = params.listName.trim();
  if (!name) throw new Error("List name is required");
  assertNotReservedName(name);
  await assertEditable(listId);

  const { error } = await supabase
    .from("lists")
    .update({ list_name: name })
    .eq("list_id", listId);
  if (error) throw error;
}

/**
 * Deletes a list. Refuses the ALL list. list_words rows cascade away (schema);
 * the words themselves and the user's mastery survive (their "universal brain").
 *
 * OUTPUT: void.
 * CONSTRAINTS: refuses ALL; list_words cascade; words + mastery survive.
 */
export async function deleteList(listId: string): Promise<void> {
  await assertEditable(listId);

  const { error } = await supabase.from("lists").delete().eq("list_id", listId);
  if (error) throw error;
}
