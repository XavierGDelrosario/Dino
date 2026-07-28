// The Lists screen: list chips (ALL + sub-lists), the words in the selected list
// with sort/filter controls, and the add/review actions. Orchestration only —
// each piece (chips, add forms, period filter, word row) is its own component;
// this view owns the filter state and wires the useLists callbacks.
//
// "ALL" is the virtual whole-vocabulary view (not a stored list). Adding a word
// while a sub-list is selected also tags it into that sub-list.
import { useEffect, useMemo, useState } from "react";
import { useLists } from "../hooks/useLists";
import { ListRow } from "../components/lists/ListRow";
import { ListChips } from "../components/lists/ListChips";
import { SelectionBar } from "../components/lists/SelectionBar";
import { AddWordForm } from "../components/lists/AddWordForm";
import { FilterButton, FilterPanel } from "../components/lists/FilterMenu";
import {
  activeFilterCount,
  makeMatcher,
  NO_FILTERS,
  type WordFilters,
} from "../services/words/filters";
import { makeSearchMatcher } from "../services/words/search";
import { partOfSpeechCategory, POS_CATEGORIES, type PosCategory } from "../services/language";
import { getDifficulty } from "../services/difficulty";
import { useI18n } from "../i18n";
import { SearchIcon, XIcon } from "../components/common/icons";
import { SortControls, type SortDir } from "../components/common/SortControls";
import { Pager } from "../components/common/Pager";
import { AnalyzeInfographic } from "../components/common/AnalyzeInfographic";
import { summarizeUserWords } from "../services/analyze/summarize";
import { PAGE_SIZE } from "../lib/pagination";
import { ErrorText } from "../components/common/ErrorText";
import type { UserWord } from "../services/words/userWords";
import { useStickyState } from "../hooks/useStickyState";
import "../components/lists/lists.css";

// Sort AXIS (the four that transfer from the article summary + the vocab-history
// "added" axis) crossed with a least/most DIRECTION. "added" bundles NEWEST with
// "least" (a recent word is the "least aged"); the others read literally.
type SortAxis = "added" | "common" | "confident" | "difficult";

// A sub-list's "Review" quizzes at most this many of its (filtered) words per
// session — the most-overdue first (the SQL explicit-set path ranks them). A
// separate "Review all" button appears only when the list holds more, so the
// whole set is still reachable in one go.
const SUBLIST_REVIEW_CAP = 20;

/** Order a set of words by the chosen axis + direction. Shared by the filtered set
 *  and the pinned selection, so a pick keeps its place in the list's ordering. */
function sortWords(ws: UserWord[], axis: SortAxis, dir: SortDir): UserWord[] {
  const sign = dir === "most" ? -1 : 1; // ascending (least) by default
  const date = (w: UserWord) => Date.parse(w.originallyTranslatedDate); // higher = newer
  const recent = (a: UserWord, b: UserWord) => date(b) - date(a); // newest-first tiebreak
  const sorted = [...ws];

  switch (axis) {
    case "added":
      // least = NEWEST, most = oldest.
      sorted.sort((a, b) => (date(b) - date(a)) * sign);
      break;
    case "confident":
      sorted.sort((a, b) => (a.confidenceRating - b.confidenceRating) * sign || recent(a, b));
      break;
    case "common":
      sorted.sort(
        (a, b) => ((a.frequency ?? -Infinity) - (b.frequency ?? -Infinity)) * sign || recent(a, b),
      );
      break;
    case "difficult": {
      // Precompute the 1..5 level once per word (getDifficulty is pure but a sort
      // calls the comparator O(n log n) times). Unrated (null) sinks either way.
      const lvl = new Map(ws.map((w) => [w, getDifficulty(w).level]));
      sorted.sort((a, b) => {
        const da = lvl.get(a) ?? null;
        const db = lvl.get(b) ?? null;
        if (da == null) return db == null ? recent(a, b) : 1;
        if (db == null) return -1;
        return (da - db) * sign || recent(a, b);
      });
      break;
    }
  }
  return sorted;
}

export function ListView({
  userId,
  onReview,
}: {
  userId: string;
  onReview: (
    listId: string | null,
    name: string,
    userWordIds?: string[],
    limit?: number,
  ) => void;
}) {
  const L = useLists(userId);
  const { t } = useI18n();
  const selectedList = L.lists.find((l) => l.listId === L.selectedListId) ?? null;

  const [sortAxis, setSortAxis] = useStickyState<SortAxis>(userId, "lists.sortAxis", "added");
  const [sortDir, setSortDir] = useStickyState<SortDir>(userId, "lists.sortDir", "least");
  // Free-text search (headword · meaning · reading — see services/words/search.ts). Kept
  // out of `filters`: that value is the funnel menu's, and a query isn't an axis you
  // toggle. It narrows the same way a filter does, though — see `visible`.
  const [query, setQuery] = useStickyState(userId, "lists.query", "");
  // Which panel is open below the actions row. ONE at a time — both are big blocks
  // that push the rows down, so stacking them would bury the list.
  const [panel, setPanel] = useState<"add" | "filter" | "summary" | null>(null);
  // EVERY filter (language → its levels · usage · POS · added · reviewed ·
  // confidence) lives in this one value, owned by the funnel menu (which is
  // presentational). The resting value narrows nothing; the view only sorts + pages.
  const [filters, setFilters] = useStickyState<WordFilters>(userId, "lists.filters", NO_FILTERS);

  // Anything narrowing WHICH words show (sort doesn't change the set). The search query
  // counts: "Review" quizzes exactly what's on screen, and a search is how you'd pick the
  // handful of words you want to drill. Memoized on `filters` alone — ListView re-renders
  // on every keystroke/page/select-toggle, and the count walks each language's bands.
  const filtersActive =
    useMemo(() => activeFilterCount(filters), [filters]) > 0 || query.trim() !== "";

  // The attribute values actually present in the current list — the filter menu only
  // offers a language/word class you could actually match.
  const langsPresent = useMemo(
    () => [...new Set(L.words.map((w) => w.sourceLang))].sort(),
    [L.words]
  );
  const posPresent = useMemo(() => {
    const present = new Set(
      L.words.map((w) => partOfSpeechCategory(w.partOfSpeech)).filter((c): c is PosCategory => c != null)
    );
    // Keep the catalog's order (noun, pronoun, verb, …) rather than encounter order.
    return POS_CATEGORIES.filter((c) => present.has(c));
  }, [L.words]);

  // The words the current filters match, in the chosen sort order.
  // makeMatcher, not matchesFilters: the cutoffs/bounds/band sets are resolved ONCE
  // per pass rather than per word (a confidence drag re-filters on every pointer event).
  const visible = useMemo(() => {
    const matchesFilter = makeMatcher(filters);
    const matchesQuery = makeSearchMatcher(query);
    return sortWords(
      L.words.filter((w) => matchesFilter(w) && matchesQuery(w)),
      sortAxis,
      sortDir
    );
  }, [L.words, filters, query, sortAxis, sortDir]);

  // The summary charts the words CURRENTLY ON SCREEN — the same set Review quizzes,
  // so filtering to "N3 verbs I keep forgetting" and hitting Summary describes that
  // slice, not the whole list. Built only while the panel is open (it walks every
  // word, and the list re-renders on every keystroke and page turn).
  const summary = useMemo(
    () => (panel === "summary" ? summarizeUserWords(visible) : null),
    [panel, visible]
  );

  // ---- Multi-select -------------------------------------------------------
  // Selection is held as user_word IDs, NOT rows, and is deliberately NOT cleared
  // when a filter/sort/page changes: filter → select → re-filter → select is how a
  // user assembles a set out of several slices, so the picks have to outlive the
  // filter that surfaced them. It IS cleared when the LIST scope changes (a
  // different chip is a different vocabulary slice, not a filter of this one).
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setPicked(new Set());
  }, [L.selectedListId]);

  // Words can vanish underneath a selection (deleted, or un-tagged from this
  // sub-list), so never trust a raw id — reconcile against the cache before it
  // reaches a count, a button, or a write.
  const selected = useMemo(() => {
    const live = new Set(L.words.map((w) => w.userWordId));
    return [...picked].filter((id) => live.has(id));
  }, [picked, L.words]);

  const toggleOne = (userWordId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(userWordId)) next.add(userWordId);
      return next;
    });

  const exitSelect = () => {
    setSelectMode(false);
    setPicked(new Set());
  };

  // What actually gets rendered. A picked word is PINNED to the top and stays there
  // even when the current filters exclude it — otherwise narrowing the filter would
  // hide part of the set you're assembling, and you could no longer see (or unpick)
  // what you'd already chosen. Outside select mode this is just the filtered set.
  const rows = useMemo(() => {
    if (!selectMode || picked.size === 0) return visible;
    const pinned = sortWords(
      L.words.filter((w) => picked.has(w.userWordId)),
      sortAxis,
      sortDir
    );
    const pinnedIds = new Set(pinned.map((w) => w.userWordId));
    return [...pinned, ...visible.filter((w) => !pinnedIds.has(w.userWordId))];
  }, [selectMode, picked, visible, L.words, sortAxis, sortDir]);

  // Paged rendering (pure client-side slicing — the whole list is already cached).
  // `page` is 0-indexed. Jump back to the first page whenever the list or a
  // filter/sort CHANGES (a different set) — but NOT when the page itself changes,
  // so switching pages never resets the filters. Also NOT reset while background
  // batches stream in, so the position holds as the cache fills.
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [L.selectedListId, sortAxis, sortDir, filters, query]);

  // Paged over `rows` (filtered set + pinned picks), so the pinned block leads page 1.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Clamp for display so a deletion/streaming change that shrinks the set can't
  // strand us past the last page (the state is corrected by the effect on the next
  // filter change; this keeps the current render valid meanwhile).
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const shown = rows.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <section className="lists">
      <ListChips
        lists={L.lists}
        selectedListId={L.selectedListId}
        onSelect={L.setSelectedListId}
        onCreate={L.addList}
      />

      <div className="lists__bar">
        <h2 className="lists__title">
          {selectedList ? selectedList.listName : t("lists.allWords")}
          {/* Count reflects the FILTERED set actually shown (equals the list total
              when no filter is active), not the raw list size. */}
          <span className="lists__count">{rows.length}</span>
        </h2>
        {L.words.length > 0 && (
          <>
            <button
              className="btn btn--sm lists__reviewbtn"
              onClick={() =>
                selectedList
                  ? // A sub-list: quiz its (filtered) words as an explicit set, capped —
                    // the SQL takes the most-overdue SUBLIST_REVIEW_CAP of them.
                    onReview(
                      L.selectedListId,
                      selectedList.listName,
                      visible.map((w) => w.userWordId),
                      SUBLIST_REVIEW_CAP,
                    )
                  : // ALL: filter active → exactly the filtered words; otherwise the
                    // scheduled queue (weakest N) as before.
                    onReview(
                      L.selectedListId,
                      "",
                      filtersActive ? visible.map((w) => w.userWordId) : undefined,
                    )
              }
              title={selectedList ? t("lists.reviewCappedTitle") : t("lists.reviewTitle")}
            >
              {t("lists.reviewBtn")}
            </button>
            {/* Only a sub-list, and only when it holds more than one capped session —
                otherwise "Review" already covers every word. Runs the whole set. */}
            {selectedList && visible.length > SUBLIST_REVIEW_CAP && (
              <button
                className="btn btn--sm lists__reviewbtn"
                onClick={() =>
                  onReview(
                    L.selectedListId,
                    selectedList.listName,
                    visible.map((w) => w.userWordId),
                  )
                }
                title={t("lists.reviewAllTitle", { n: visible.length })}
              >
                {t("lists.reviewAll", { n: visible.length })}
              </button>
            )}
            {/* Same set as Review, described instead of quizzed. */}
            <button
              className={`btn btn--sm lists__reviewbtn${panel === "summary" ? " btn--primary" : ""}`}
              onClick={() => setPanel((p) => (p === "summary" ? null : "summary"))}
              aria-expanded={panel === "summary"}
              title={t("lists.summaryTitle")}
            >
              {t("lists.summaryBtn")}
            </button>
          </>
        )}
        {selectedList && (
          <button
            className="btn btn--sm btn--danger lists__deletebtn"
            onClick={() => {
              if (confirm(t("lists.deleteConfirm", { name: selectedList.listName })))
                L.deleteListById(selectedList.listId);
            }}
            title={t("lists.deleteListTitle")}
          >
            {t("lists.deleteListBtn")}
          </button>
        )}
      </div>

      {/* Charts for the filtered set, directly under the button that opens them (which
          lives in the title bar) — so the summary sits ABOVE the add/select/filter row
          rather than below everything those panels can open. No coverage pie: every word
          here is already in the vocabulary, so known/new is 100/0 by construction — see
          summarizeUserWords. No word count either: the title chip and the row count
          already carry it. */}
      {panel === "summary" && summary && (
        <div className="lists__summary">
          <AnalyzeInfographic data={summary.data} />
        </div>
      )}

      {/* The ACTIONS row: add · select · filter. The buttons STAY PUT — whichever
          panel they open renders below the whole row (in the page flow, pushing the
          rows down), never as a floating card over the list. Sort is not here: it
          only reorders what's already on screen, so it lives with the rows. */}
      <div className="lists__toolbar">
        <button
          className={`btn lists__addtoggle${panel === "add" ? " btn--primary" : ""}`}
          onClick={() => setPanel((p) => (p === "add" ? null : "add"))}
          aria-expanded={panel === "add"}
        >
          {t("lists.addWordToggle")}
        </button>

        {L.status === "ready" && L.words.length > 0 && (
          <>
            {/* Select mode: turns every row into a checkbox and reveals the
                selection toolbar. Leaving it drops the picks. */}
            <button
              className={`btn lists__addtoggle${selectMode ? " btn--primary" : ""}`}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              aria-pressed={selectMode}
            >
              {selectMode ? t("lists.selectDone") : t("lists.select")}
            </button>

            <FilterButton
              filters={filters}
              open={panel === "filter"}
              onToggle={() => setPanel((p) => (p === "filter" ? null : "filter"))}
            />
          </>
        )}
      </div>

      {/* Selection bar — its own row, centred directly under the Select button that
          turns it on. It acts on the picked words, not on the list's ordering, so it
          belongs with the actions rather than on the sort line. */}
      {L.status === "ready" && selectMode && L.words.length > 0 && (
          <SelectionBar
            count={selected.length}
            visibleCount={visible.length}
            allVisibleSelected={
              visible.length > 0 && visible.every((w) => picked.has(w.userWordId))
            }
            lists={L.lists}
            // Adds the filtered set to the picks (union, not replace) — see SelectionBar.
            onSelectAll={() =>
              setPicked((prev) => new Set([...prev, ...visible.map((w) => w.userWordId)]))
            }
            onUnselectAll={() => setPicked(new Set())}
            // Keep the selection if the write failed (the error shows above); only a
            // successful tag ends the operation.
            onAddToList={(listId) => {
              void L.tagWords(selected, listId).then((ok) => ok && exitSelect());
            }}
            onCreateList={(name) =>
              L.createListForWords(selected, name).then((ok) => {
                if (ok) exitSelect();
              })
            }
          />
      )}

      {/* One form for both adds: Translate fills the meaning from the dictionary, or
          type your own — the meaning field decides which write happens. */}
      {panel === "add" && (
        <AddWordForm
          userId={userId}
          lookup={L.lookupDictionary}
          onSaveSense={L.saveSenseToList}
          onAddCustom={L.addCustomWord}
          onClose={() => setPanel(null)}
        />
      )}

      {/* Attribute + history filters (language → its levels · usage · word class ·
          added · reviewed · confidence). The language buttons replace the old
          single-select: the language a word is IN also decides which proficiency
          scale it can be filtered by. */}
      {panel === "filter" && (
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onClose={() => setPanel(null)}
          langsPresent={langsPresent}
          posPresent={posPresent}
        />
      )}

      <ErrorText message={L.error} />

      {L.status === "loading" && <p className="review__msg">{t("common.loading")}</p>}

      {L.status === "ready" && L.words.length === 0 && (
        <p className="review__msg">
          {selectedList ? t("lists.emptyList") : t("lists.emptyAll")}
        </p>
      )}

      {/* The row directly above the words: sort, then search. Both act on the rows below
          (reorder them / narrow them), so they share ONE line. Gated on the LIST having
          words, not on any being shown — a search that matches nothing must keep its own
          box on screen, or you'd have no way to edit or clear the query that emptied the
          list. */}
      {L.status === "ready" && L.words.length > 0 && (
        <div className="listrows__sort">
          <SortControls
            label={t("sort.label")}
            flipLabel={t("sort.flip")}
            options={[
              { value: "added", least: t("lists.sortNewest"), most: t("lists.sortOldest") },
              { value: "common", least: t("sort.leastCommon"), most: t("sort.mostCommon") },
              { value: "confident", least: t("sort.leastConfident"), most: t("sort.mostConfident") },
              { value: "difficult", least: t("sort.leastDifficult"), most: t("sort.mostDifficult") },
            ]}
            value={sortAxis}
            dir={sortDir}
            onValue={(v) => setSortAxis(v as SortAxis)}
            onDir={setSortDir}
          />

          <div className="listrows__search">
            {/* Decorative — the input already carries the label. */}
            <span className="listrows__searchicon" aria-hidden="true">
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              className="input input--sm listrows__searchinput"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("lists.searchPlaceholder")}
              aria-label={t("lists.searchAria")}
            />
            {query && (
              <button
                type="button"
                className="listrows__searchclear"
                onClick={() => setQuery("")}
                aria-label={t("lists.searchClear")}
              >
                <XIcon size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Nothing matches — but a pinned pick still counts as a row, so key this on
          `rows`, or the picks would render underneath a "no matches" message. */}
      {L.status === "ready" && L.words.length > 0 && rows.length === 0 && (
        <p className="review__msg">{t("lists.noMatch")}</p>
      )}

      {L.status === "ready" && shown.length > 0 && (
        // In select mode the rows are options (role="option" + aria-selected), so the
        // list itself must say it's a multi-select listbox for that to be coherent.
        <ul
          className="listrows"
          role={selectMode ? "listbox" : undefined}
          aria-multiselectable={selectMode ? true : undefined}
        >
          {shown.map((w) => (
            <ListRow
              key={w.userWordId}
              word={w}
              lists={L.lists}
              selectable={selectMode}
              selected={picked.has(w.userWordId)}
              onToggleSelect={() => toggleOne(w.userWordId)}
              onEdit={(translation) => L.editWord(w.userWordId, translation)}
              onDelete={() => {
                // Only reachable from ALL — a sub-list shows "remove from list"
                // (onRemoveFromList) instead of delete-from-vocabulary.
                if (confirm(t("lists.deleteWordConfirm", { word: w.input })))
                  L.deleteWord(w.userWordId);
              }}
              onTag={(listId) => L.tagWord(w.userWordId, listId)}
              onCreateList={(name) => L.createListForWord(w.userWordId, name)}
              onRemoveFromList={
                selectedList
                  ? () => {
                      // Un-tag only: the word stays in the vocabulary.
                      if (
                        confirm(
                          t("lists.removeFromListConfirm", {
                            word: w.input,
                            list: selectedList.listName,
                          }),
                        )
                      )
                        L.untagWord(w.userWordId);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {/* Pager: switches the 100-row window over the already-cached rows (no fetch).
          Only shown when the matches span more than one page. Changing the page
          leaves every filter/sort control untouched. */}
      {L.status === "ready" && <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />}

      {/* Results footer: the whole list is cached (streamed in batches), so filters
          apply across every word. Reports the visible range / match / total, and
          flags while later batches are still arriving (counts are exact once done). */}
      {L.status === "ready" && L.words.length > 0 && (
        <p className="listrows__count">
          {pageCount > 1
            ? t("lists.showingRange", {
                from: pageStart + 1,
                to: pageStart + shown.length,
                total: rows.length,
              })
            : filtersActive
              ? t("lists.showingFiltered", { shown: rows.length, total: L.words.length })
              : t("lists.showingTotal", { total: L.words.length })}
          {!L.fullyLoaded && ` · ${t("lists.loadingAll")}`}
        </p>
      )}
    </section>
  );
}
