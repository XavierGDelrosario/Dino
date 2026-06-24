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
  USER_WORDS_PAGE_SIZE,
  saveDictionaryWord,
  createCustomWord,
  editUserWord,
  deleteUserWord,
  addUserWordToList,
  removeUserWordFromList,
  type UserWord,
} from "../services/words/userWords";
import { lookupWord } from "../services/lookup";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";
import type { LangCode, SourceSelection } from "../services/language";

export type ListStatus = "loading" | "ready" | "error";

export function useLists(userId: string) {
  const [lists, setLists] = useState<List[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null); // null = ALL
  const [words, setWords] = useState<UserWord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<ListStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    try {
      setLists(await listUserLists(userId));
    } catch (e) {
      setError(message(e));
    }
  }, [userId]);

  // Fetch one page (the ALL vocabulary or a sub-list) at the given offset.
  const fetchPage = useCallback(
    (offset: number) =>
      selectedListId === null
        ? getAllUserWords({ userId, offset, limit: USER_WORDS_PAGE_SIZE })
        : getUserWordsInList({ listId: selectedListId, offset, limit: USER_WORDS_PAGE_SIZE }),
    [userId, selectedListId]
  );

  // (Re)load the FIRST page — used on list switch and after every mutation. A full
  // page implies more rows; the view shows a "Load more" affordance then.
  const loadWords = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const w = await fetchPage(0);
      setWords(w);
      setHasMore(w.length === USER_WORDS_PAGE_SIZE);
      setStatus("ready");
    } catch (e) {
      setError(message(e));
      setStatus("error");
    }
  }, [fetchPage]);

  // Append the next page (offset = current count). No-op while one is in flight or
  // there's nothing more.
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const more = await fetchPage(words.length);
      setWords((cur) => [...cur, ...more]);
      setHasMore(more.length === USER_WORDS_PAGE_SIZE);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, words.length, hasMore, loadingMore]);

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

  /** Look a word up in the dictionary — ALL senses, no save. The UI auto-adds
   *  the primary and offers the rest. */
  const lookupDictionary = useCallback(
    (p: { input: string; sourceLang: SourceSelection; targetLang: LangCode }) =>
      lookupWord({ input: p.input, sourceLang: p.sourceLang, targetLang: p.targetLang }),
    []
  );

  /** Save one dictionary sense into the current list (+ ALL), then refresh. */
  const saveSenseToList = useCallback(
    async (word: Word) => {
      await saveDictionaryWord({ userId, word, listId: selectedListId ?? undefined });
      await loadWords();
    },
    [userId, selectedListId, loadWords]
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
    hasMore,
    loadMore,
    loadingMore,
    status,
    error,
    addCustomWord,
    lookupDictionary,
    saveSenseToList,
    editWord,
    deleteWord,
    untagWord,
    tagWord,
    addList,
    renameListById,
    deleteListById,
  };
}
