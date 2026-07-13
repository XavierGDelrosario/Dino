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
import { partOfSpeechCategory, POS_CATEGORIES, type PosCategory } from "../services/language";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import type { UserWord } from "../services/words/userWords";
import "../components/lists/lists.css";

type SortBy = "newest" | "oldest" | "conf-asc" | "conf-desc";

// Max rows drawn per page. The whole list is cached (so filters/counts are
// exact); rendering is split into fixed pages so the user isn't handed a wall of
// hundreds of rows. Changing the page only moves the window — it never touches
// the filter/sort state.
const PAGE_SIZE = 100;

/** Order a set of words by the chosen sort. Shared by the filtered set and the
 *  pinned selection, so a pick keeps its place in the list's ordering. */
function sortWords(ws: UserWord[], sort: SortBy): UserWord[] {
  const byDate = (a: UserWord, b: UserWord) =>
    Date.parse(a.originallyTranslatedDate) - Date.parse(b.originallyTranslatedDate);
  const byConf = (a: UserWord, b: UserWord) => a.confidenceRating - b.confidenceRating;

  const sorted = [...ws];
  switch (sort) {
    case "newest": sorted.sort((a, b) => byDate(b, a)); break;
    case "oldest": sorted.sort(byDate); break;
    // confidence ties break on most-recently-added
    case "conf-asc": sorted.sort((a, b) => byConf(a, b) || byDate(b, a)); break;
    case "conf-desc": sorted.sort((a, b) => byConf(b, a) || byDate(b, a)); break;
  }
  return sorted;
}

// The page numbers to render in the pager: always the first and last, plus a
// window around the current page, with "…" gaps collapsed. All 0-indexed.
function pageWindow(current: number, count: number): (number | "gap")[] {
  const keep = new Set<number>([0, count - 1]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 0 && p < count) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let prev = -1;
  for (const p of sorted) {
    if (prev >= 0 && p - prev > 1) out.push("gap");
    out.push(p);
    prev = p;
  }
  return out;
}

export function ListView({
  userId,
  onReview,
}: {
  userId: string;
  onReview: (listId: string | null, name: string, userWordIds?: string[]) => void;
}) {
  const L = useLists(userId);
  const { t } = useI18n();
  const selectedList = L.lists.find((l) => l.listId === L.selectedListId) ?? null;

  const [sort, setSort] = useState<SortBy>("newest");
  // Which panel is open below the actions row. ONE at a time — both are big blocks
  // that push the rows down, so stacking them would bury the list.
  const [panel, setPanel] = useState<"add" | "filter" | null>(null);
  // EVERY filter (language → its levels · usage · POS · added · reviewed ·
  // confidence) lives in this one value, owned by the funnel menu (which is
  // presentational). The resting value narrows nothing; the view only sorts + pages.
  const [filters, setFilters] = useState<WordFilters>(NO_FILTERS);

  // Any filter narrowing WHICH words show (sort doesn't change the set).
  const filtersActive = activeFilterCount(filters) > 0;

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
  const visible = useMemo(
    () => sortWords(L.words.filter(makeMatcher(filters)), sort),
    [L.words, filters, sort]
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
      sort
    );
    const pinnedIds = new Set(pinned.map((w) => w.userWordId));
    return [...pinned, ...visible.filter((w) => !pinnedIds.has(w.userWordId))];
  }, [selectMode, picked, visible, L.words, sort]);

  // Paged rendering (pure client-side slicing — the whole list is already cached).
  // `page` is 0-indexed. Jump back to the first page whenever the list or a
  // filter/sort CHANGES (a different set) — but NOT when the page itself changes,
  // so switching pages never resets the filters. Also NOT reset while background
  // batches stream in, so the position holds as the cache fills.
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [L.selectedListId, sort, filters]);

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
          <button
            className="btn btn--sm lists__reviewbtn"
            onClick={() =>
              onReview(
                L.selectedListId,
                selectedList ? selectedList.listName : "",
                // With a filter active, quiz exactly the filtered words shown;
                // otherwise review the whole list/vocabulary as before.
                filtersActive ? visible.map((w) => w.userWordId) : undefined
              )
            }
            title={t("lists.reviewTitle")}
          >
            {t("lists.reviewBtn")}
          </button>
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

      {/* Nothing matches — but a pinned pick still counts as a row, so key this on
          `rows`, or the picks would render underneath a "no matches" message. */}
      {L.status === "ready" && L.words.length > 0 && rows.length === 0 && (
        <p className="review__msg">{t("lists.noMatch")}</p>
      )}

      {/* Selection toolbar — sits directly above the rows, actions to the right. */}
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

      {/* Sort belongs to the ROWS (it only reorders what's already shown), so it sits
          right on top of them rather than up with the actions. */}
      {L.status === "ready" && shown.length > 0 && (
        <div className="listrows__sort">
          <select
            className="select select--sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortBy)}
            aria-label={t("lists.sortAria")}
          >
            <option value="newest">{t("lists.sortNewest")}</option>
            <option value="oldest">{t("lists.sortOldest")}</option>
            <option value="conf-asc">{t("lists.sortConfAsc")}</option>
            <option value="conf-desc">{t("lists.sortConfDesc")}</option>
          </select>
        </div>
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
      {L.status === "ready" && pageCount > 1 && (
        <nav className="listrows__pager" aria-label={t("lists.pagerAria")}>
          <button
            className="btn btn--sm listrows__pageredge"
            onClick={() => setPage((p) => Math.max(0, Math.min(p, pageCount - 1) - 1))}
            disabled={currentPage === 0}
          >
            {t("lists.prevPage")}
          </button>
          <div className="listrows__pagenums">
            {pageWindow(currentPage, pageCount).map((p, i) =>
              p === "gap" ? (
                <span key={`gap-${i}`} className="listrows__pagegap">…</span>
              ) : (
                <button
                  key={p}
                  className={`btn btn--sm listrows__pagenum${
                    p === currentPage ? " listrows__pagenum--active" : ""
                  }`}
                  onClick={() => setPage(p)}
                  aria-current={p === currentPage ? "page" : undefined}
                  aria-label={t("lists.gotoPage", { n: p + 1 })}
                >
                  {p + 1}
                </button>
              )
            )}
          </div>
          <button
            className="btn btn--sm listrows__pageredge"
            onClick={() => setPage((p) => Math.min(pageCount - 1, Math.min(p, pageCount - 1) + 1))}
            disabled={currentPage === pageCount - 1}
          >
            {t("lists.nextPage")}
          </button>
        </nav>
      )}

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
