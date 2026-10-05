// Drives the Lists view: the user's sub-lists + the words in the selected one, where
// null = the virtual ALL list (the whole vocabulary IS the user_words rows; there is no
// ALL row). Errors surface in `error` rather than throwing to the view.
//
// Reads come from the session VOCABULARY CACHE (services/words/vocabularyCache): ALL
// loads once, and every list is a filter over it, so switching chips — or leaving the
// tab and coming back — costs no request. Mutations go through the services, which
// write their results through to that cache; this hook re-renders from it and never
// patches words itself.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createList as createListSvc,
  renameList as renameListSvc,
  deleteList as deleteListSvc,
  type List,
} from "../services/lists";
import {
  saveDictionaryWord,
  createCustomWord,
  editUserWord,
  revertUserWord,
  deleteUserWord,
  deleteUserWords,
  addUserWordsToList,
  removeUserWordFromList,
  removeUserWordsFromList,
} from "../services/words/userWords";
import {
  cachedLists,
  hasWords,
  isReadable,
  subscribeVocabulary,
  vocabularyVersion,
  wordsFor,
} from "../services/words/vocabularyCache";
import { ensureVocabulary } from "../services/words/vocabularyLoader";
import { lookupWord } from "../services/lookup";
import { softenConfidence } from "../services/review";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";
import type { LangCode, SourceSelection } from "../services/language";
import { useStickyState } from "./useStickyState";

export type ListStatus = "loading" | "ready" | "error";

const NO_LISTS: List[] = [];

// The cache loads whether or not the word table is on screen — on the overview it warms
// up once, so opening any list from there is instant.
export function useLists(userId: string) {
  // null = ALL. Sticky, so returning to Lists keeps the chip you were on — but a list
  // can be deleted elsewhere while you're away, so it's validated against `lists`
  // once they load rather than trusted.
  const [selectedListId, setSelectedListId] = useStickyState<string | null>(
    userId, "lists.selectedListId", null,
  );
  const [error, setError] = useState<string | null>(null);
  /** The cold load failed (a failed background re-check keeps the cached copy). */
  const [loadFailed, setLoadFailed] = useState(false);

  const version = useSyncExternalStore(subscribeVocabulary, vocabularyVersion);

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    ensureVocabulary(userId).catch((e) => {
      if (!live) return;
      setError(message(e));
      setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [userId]);

  // The store replaces `lists` on change, so its reference is already stable.
  const cached = cachedLists(userId);
  const lists = cached ?? NO_LISTS;
  const listsLoaded = cached !== null;
  // `version` moves on each page and each write — it is what makes this re-read.
  const words = useMemo(() => wordsFor(userId, selectedListId), [userId, selectedListId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Filters/counts are exact once this is true.
  const fullyLoaded = isReadable(userId, selectedListId);
  // ALL paints from its first page; a sub-list needs ALL complete + the membership.
  const shown = selectedListId === null ? hasWords(userId) : fullyLoaded;
  const status: ListStatus = shown ? "ready" : loadFailed ? "error" : "loading";

  // A restored selection can point at a list deleted on another surface or device —
  // fall back to ALL rather than showing a list that no longer exists.
  useEffect(() => {
    if (!listsLoaded || selectedListId === null) return;
    if (!lists.some((l) => l.listId === selectedListId)) setSelectedListId(null);
  }, [listsLoaded, lists, selectedListId, setSelectedListId]);

  // Run a mutation and surface any error. On success the service has already written
  // the result through to the cache; on failure the cache is left untouched. Returns
  // whether it succeeded — callers that discard UI state on completion (e.g. the
  // multi-select clearing its picks) must NOT do so on a failure the user still
  // has to react to. Callers that don't care can keep ignoring the result.
  const guard = useCallback(async (op: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await op();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }, []);

  const addCustomWord = useCallback(
    (p: { input: string; translation: string; sourceLang: LangCode; targetLang: LangCode }) =>
      guard(async () => {
        await createCustomWord({ userId, ...p, listId: selectedListId ?? undefined });
      }),
    [guard, userId, selectedListId]
  );

  /** Look a word up in the dictionary — ALL senses, no save. The UI auto-adds
   *  the primary and offers the rest. */
  const lookupDictionary = useCallback(
    (p: { input: string; sourceLang: SourceSelection; targetLang: LangCode }) =>
      lookupWord({ input: p.input, sourceLang: p.sourceLang, targetLang: p.targetLang }),
    []
  );

  /** Save one dictionary sense into the current list (+ ALL).
   *  Errors propagate so the caller (AddWord) can react. */
  const saveSenseToList = useCallback(
    async (word: Word) => {
      await saveDictionaryWord({ userId, word, listId: selectedListId ?? undefined });
    },
    [userId, selectedListId]
  );

  const editWord = useCallback(
    (userWordId: string, translation: string) =>
      guard(async () => {
        await editUserWord({ userWordId, translation });
      }),
    [guard]
  );

  /** "Revert to original": drop the user's own meaning for the dictionary's. */
  const revertWord = useCallback(
    (userWordId: string) =>
      guard(async () => {
        await revertUserWord({ userWordId });
      }),
    [guard]
  );

  /** "Forgot" from the row's confidence dots: drop this word one displayed-confidence
   *  bucket (services/review.softenConfidence — a self-report, not a graded review).
   *  The server no-ops below SOFTEN_MIN_CONFIDENCE and again for a word touched in the
   *  last 2s, so a double-press returns the same row rather than dropping two notches;
   *  the cache takes whatever it actually returns rather than assuming −1. */
  const softenWord = useCallback(
    (userWordId: string) =>
      guard(async () => {
        await softenConfidence({ userWordId });
      }),
    [guard],
  );

  const deleteWord = useCallback(
    (userWordId: string) =>
      guard(async () => {
        await deleteUserWord({ userWordId });
      }),
    [guard]
  );

  // Un-tag from the current sub-list → the word leaves THIS view (stays in ALL).
  const untagWord = useCallback(
    (userWordId: string) => {
      if (selectedListId === null) return Promise.resolve();
      return guard(async () => {
        await removeUserWordFromList({ listId: selectedListId, userWordId });
      });
    },
    [guard, selectedListId]
  );

  // The multi-select flavours of the two above. Chunked, so a failure can land part-way:
  // the cache already reflects what went, and `false` tells the caller to keep the
  // rest of the selection for a retry.
  const deleteWords = useCallback(
    (userWordIds: string[]) => guard(() => deleteUserWords({ userWordIds })),
    [guard]
  );
  const untagWords = useCallback(
    (userWordIds: string[]) => {
      if (selectedListId === null) return Promise.resolve(false);
      return guard(() => removeUserWordsFromList({ listId: selectedListId, userWordIds }));
    },
    [guard, selectedListId]
  );

  // Tag a selection into an existing sub-list (one round trip); the service records
  // the new membership in the cache. The single-word row action is just the 1-element case (below),
  // so the two paths can't drift.
  const tagWords = useCallback(
    (userWordIds: string[], listId: string) =>
      guard(() => addUserWordsToList({ listId, userWordIds })),
    [guard]
  );

  // Same, into a brand-new sub-list ("New list…" from the selection toolbar or a row).
  // The new list reaches the chips/menus through the cache.
  const createListForWords = useCallback(
    (userWordIds: string[], name: string) =>
      guard(async () => {
        const list = await createListSvc({ userId, listName: name });
        await addUserWordsToList({ listId: list.listId, userWordIds });
      }),
    [guard, userId]
  );

  // The ListRow (single-word) flavours of the two above.
  const tagWord = useCallback(
    (userWordId: string, listId: string) => tagWords([userWordId], listId),
    [tagWords]
  );
  const createListForWord = useCallback(
    (userWordId: string, name: string) => createListForWords([userWordId], name),
    [createListForWords]
  );

  const addList = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const list = await createListSvc({ userId, listName: name });
        setSelectedListId(list.listId);
      } catch (e) {
        setError(message(e));
      }
    },
    [userId, setSelectedListId]
  );

  const renameListById = useCallback(
    async (listId: string, name: string) => {
      setError(null);
      try {
        await renameListSvc({ listId, listName: name });
      } catch (e) {
        setError(message(e));
      }
    },
    []
  );

  const deleteListById = useCallback(
    async (listId: string) => {
      setError(null);
      try {
        await deleteListSvc(listId);
        if (selectedListId === listId) setSelectedListId(null);
      } catch (e) {
        setError(message(e));
      }
    },
    [selectedListId, setSelectedListId]
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
    revertWord,
    softenWord,
    deleteWord,
    deleteWords,
    untagWord,
    untagWords,
    tagWord,
    tagWords,
    createListForWord,
    createListForWords,
    addList,
    renameListById,
    deleteListById,
  };
}
