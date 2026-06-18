// Drives the Lists view: the user's sub-lists + the words in the selected list.
// The selected list is either a sub-list id or null = the virtual ALL list
// (a user's whole vocabulary IS their user_words rows — there is no ALL row).
//
// Every mutation re-reads from the services (no optimistic cache) — simple and
// always-correct at POC scale. Errors surface in `error` rather than throwing
// to the view.
import { useCallback, useEffect, useState } from "react";
import {
  listUserLists,
  createList as createListSvc,
  renameList as renameListSvc,
  deleteList as deleteListSvc,
  type List,
} from "../services/lists";
import {
  getAllUserWords,
  getUserWordsInList,
  createCustomWord,
  editUserWord,
  deleteUserWord,
  addUserWordToList,
  removeUserWordFromList,
  type UserWord,
} from "../services/words/userWords";
import type { LangCode } from "../services/language";

export type ListStatus = "loading" | "ready" | "error";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useLists(userId: string) {
  const [lists, setLists] = useState<List[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null); // null = ALL
  const [words, setWords] = useState<UserWord[]>([]);
  const [status, setStatus] = useState<ListStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    try {
      setLists(await listUserLists(userId));
    } catch (e) {
      setError(message(e));
    }
  }, [userId]);

  const loadWords = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const w =
        selectedListId === null
          ? await getAllUserWords({ userId })
          : await getUserWordsInList({ listId: selectedListId });
      setWords(w);
      setStatus("ready");
    } catch (e) {
      setError(message(e));
      setStatus("error");
    }
  }, [userId, selectedListId]);

  useEffect(() => {
    loadLists();
  }, [loadLists]);
  useEffect(() => {
    loadWords();
  }, [loadWords]);

  // Run a mutation, surface any error, then refresh the word list.
  const guard = useCallback(
    async (op: () => Promise<unknown>) => {
      setError(null);
      try {
        await op();
        await loadWords();
      } catch (e) {
        setError(message(e));
      }
    },
    [loadWords]
  );

  const addCustomWord = useCallback(
    (p: { input: string; translation: string; sourceLang: LangCode; targetLang: LangCode }) =>
      guard(() =>
        createCustomWord({ userId, ...p, listId: selectedListId ?? undefined })
      ),
    [guard, userId, selectedListId]
  );

  const editWord = useCallback(
    (userWordId: string, translation: string) =>
      guard(() => editUserWord({ userWordId, translation })),
    [guard]
  );

  const deleteWord = useCallback(
    (userWordId: string) => guard(() => deleteUserWord({ userWordId })),
    [guard]
  );

  const untagWord = useCallback(
    (userWordId: string) => {
      if (selectedListId === null) return Promise.resolve();
      return guard(() => removeUserWordFromList({ listId: selectedListId, userWordId }));
    },
    [guard, selectedListId]
  );

  const tagWord = useCallback(
    (userWordId: string, listId: string) =>
      guard(() => addUserWordToList({ listId, userWordId })),
    [guard]
  );

  const addList = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const list = await createListSvc({ userId, listName: name });
        await loadLists();
        setSelectedListId(list.listId);
      } catch (e) {
        setError(message(e));
      }
    },
    [userId, loadLists]
  );

  const renameListById = useCallback(
    async (listId: string, name: string) => {
      setError(null);
      try {
        await renameListSvc({ listId, listName: name });
        await loadLists();
      } catch (e) {
        setError(message(e));
      }
    },
    [loadLists]
  );

  const deleteListById = useCallback(
    async (listId: string) => {
      setError(null);
      try {
        await deleteListSvc(listId);
        if (selectedListId === listId) setSelectedListId(null);
        await loadLists();
      } catch (e) {
        setError(message(e));
      }
    },
    [selectedListId, loadLists]
  );

  return {
    lists,
    selectedListId,
    setSelectedListId,
    words,
    status,
    error,
    addCustomWord,
    editWord,
    deleteWord,
    untagWord,
    tagWord,
    addList,
    renameListById,
    deleteListById,
  };
}
