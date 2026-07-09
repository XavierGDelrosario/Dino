// Drives the Lists view: the user's sub-lists + the words in the selected list.
// The selected list is either a sub-list id or null = the virtual ALL list
// (a user's whole vocabulary IS their user_words rows — there is no ALL row).
//
// Every mutation re-reads from the services (no optimistic cache) — simple and
// always-correct at POC scale. Errors surface in `error` rather than throwing
// to the view.
import { useCallback, useEffect, useRef, useState } from "react";
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
  // False while later batches are still streaming in (the first page shows fast,
  // the rest fill in behind it). Filters/counts are exact once this is true.
  const [fullyLoaded, setFullyLoaded] = useState(false);
  const [status, setStatus] = useState<ListStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  // Bumped on every (re)load so a superseded in-flight load (list switch)
  // stops writing state instead of racing the newer one.
  const loadSeq = useRef(0);
  // user_word_ids removed by a mutation WHILE the background stream is still
  // running — the stream filters these out so a not-yet-loaded page can't
  // resurrect a just-deleted/untagged word. Cleared at the start of each load.
  const suppressedIds = useRef<Set<string>>(new Set());

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

  // Load the WHOLE list (ALL or a sub-list) into the client cache — used only on
  // list switch / initial load, NOT after mutations (those patch the cache in
  // place, below). The list is likely to be browsed/filtered in full, so we pull
  // every row rather than paging on demand: the first page renders immediately
  // (status → ready), then the remaining pages stream in behind it in
  // USER_WORDS_PAGE_SIZE batches so a huge vocabulary isn't one giant query. The
  // view render-limits how many rows it draws ("Load more"), so a full cache never
  // means a wall of DOM. Only once `fullyLoaded` is true do filters/counts see
  // every word. Each batch MERGES onto current state (dedupe by id + skip
  // suppressed) so a mutation racing the stream isn't clobbered.
  const loadWords = useCallback(async () => {
    const seq = ++loadSeq.current;
    suppressedIds.current = new Set();
    setStatus("loading");
    setFullyLoaded(false);
    setError(null);
    try {
      const first = await fetchPage(0);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      setWords(first);
      setStatus("ready");
      if (first.length < USER_WORDS_PAGE_SIZE) {
        setFullyLoaded(true);
        return;
      }
      // Stream the rest in behind the first page, merging onto live state.
      for (let offset = first.length; ; offset += USER_WORDS_PAGE_SIZE) {
        const page = await fetchPage(offset);
        if (seq !== loadSeq.current) return; // superseded mid-stream
        setWords((cur) => {
          const seen = new Set(cur.map((w) => w.userWordId));
          const add = page.filter(
            (w) => !seen.has(w.userWordId) && !suppressedIds.current.has(w.userWordId)
          );
          return add.length ? [...cur, ...add] : cur;
        });
        if (page.length < USER_WORDS_PAGE_SIZE) break;
      }
      setFullyLoaded(true);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(message(e));
      setStatus("error");
    }
  }, [fetchPage]);

  // --- Local cache patches: apply a mutation's result to `words` in place instead
  // of re-pulling the whole list (which would re-stream every batch on each edit). ---

  /** Insert a new / re-added word (newest-first, matching the load order), unless
   *  it's already present — saves are idempotent, so a re-add may already exist. */
  const upsertLocal = useCallback((uw: UserWord) => {
    setWords((ws) => (ws.some((w) => w.userWordId === uw.userWordId) ? ws : [uw, ...ws]));
  }, []);

  /** Replace an edited word in place (position unchanged; the view re-sorts). */
  const replaceLocal = useCallback((uw: UserWord) => {
    setWords((ws) => ws.map((w) => (w.userWordId === uw.userWordId ? uw : w)));
  }, []);

  /** Drop a word from the cache and suppress it from any in-flight stream page. */
  const removeLocal = useCallback((userWordId: string) => {
    suppressedIds.current.add(userWordId);
    setWords((ws) => ws.filter((w) => w.userWordId !== userWordId));
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);
  useEffect(() => {
    loadWords();
  }, [loadWords]);

  // Run a mutation and surface any error. The caller patches the local cache on
  // success (no full reload); on failure the cache is left untouched.
  const guard = useCallback(async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const addCustomWord = useCallback(
    (p: { input: string; translation: string; sourceLang: LangCode; targetLang: LangCode }) =>
      guard(async () => {
        const uw = await createCustomWord({ userId, ...p, listId: selectedListId ?? undefined });
        upsertLocal(uw);
      }),
    [guard, userId, selectedListId, upsertLocal]
  );

  /** Look a word up in the dictionary — ALL senses, no save. The UI auto-adds
   *  the primary and offers the rest. */
  const lookupDictionary = useCallback(
    (p: { input: string; sourceLang: SourceSelection; targetLang: LangCode }) =>
      lookupWord({ input: p.input, sourceLang: p.sourceLang, targetLang: p.targetLang }),
    []
  );

  /** Save one dictionary sense into the current list (+ ALL), patching the cache.
   *  Errors propagate so the caller (AddWord) can react. */
  const saveSenseToList = useCallback(
    async (word: Word) => {
      const uw = await saveDictionaryWord({ userId, word, listId: selectedListId ?? undefined });
      upsertLocal(uw);
    },
    [userId, selectedListId, upsertLocal]
  );

  const editWord = useCallback(
    (userWordId: string, translation: string) =>
      guard(async () => {
        const uw = await editUserWord({ userWordId, translation });
        replaceLocal(uw);
      }),
    [guard, replaceLocal]
  );

  const deleteWord = useCallback(
    (userWordId: string) =>
      guard(async () => {
        await deleteUserWord({ userWordId });
        removeLocal(userWordId);
      }),
    [guard, removeLocal]
  );

  // Un-tag from the current sub-list → the word leaves THIS view (stays in ALL).
  const untagWord = useCallback(
    (userWordId: string) => {
      if (selectedListId === null) return Promise.resolve();
      return guard(async () => {
        await removeUserWordFromList({ listId: selectedListId, userWordId });
        removeLocal(userWordId);
      });
    },
    [guard, selectedListId, removeLocal]
  );

  // Tag into ANOTHER sub-list. Doesn't change the current view's membership (the
  // word is already shown here), so the cache needs no patch.
  const tagWord = useCallback(
    (userWordId: string, listId: string) =>
      guard(() => addUserWordToList({ listId, userWordId })),
    [guard]
  );

  // Create a brand-new sub-list from a row and tag this word into it (the ListRow
  // "New list…" flow). Reloads lists so the new one shows in the chips/menus; the
  // current view is unchanged (the word already appears here).
  const createListForWord = useCallback(
    (userWordId: string, name: string) =>
      guard(async () => {
        const list = await createListSvc({ userId, listName: name });
        await addUserWordToList({ listId: list.listId, userWordId });
        await loadLists();
      }),
    [guard, userId, loadLists]
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
    fullyLoaded,
    status,
    error,
    addCustomWord,
    lookupDictionary,
    saveSenseToList,
    editWord,
    deleteWord,
    untagWord,
    tagWord,
    createListForWord,
    addList,
    renameListById,
    deleteListById,
  };
}
