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
import { AddWord } from "../components/lists/AddWord";
import { AddCustomWord } from "../components/lists/AddCustomWord";
import { PeriodSelect, periodCutoff, type DatePeriod } from "../components/lists/PeriodSelect";
import { targetOptions, type LangCode } from "../services/language";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import type { UserWord } from "../services/words/userWords";
import "../components/lists/lists.css";

type SortBy = "newest" | "oldest" | "conf-asc" | "conf-desc";

// Max rows drawn per page. The whole list is cached (so filters/counts are
// exact); rendering is split into fixed pages so the user isn't handed a wall of
// hundreds of rows. Changing the page only moves the window — it never touches
// the filter/sort state.
const PAGE_SIZE = 200;

const langName = (code: string) =>
  targetOptions().find((o) => o.code === code)?.name ?? code;

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
  const [langFilter, setLangFilter] = useState<LangCode | "all">("all");
  const [addedFilter, setAddedFilter] = useState<DatePeriod>("all");
  const [reviewedFilter, setReviewedFilter] = useState<DatePeriod>("all");
  // The two thumbs are stored raw and allowed to CROSS — we never clamp one
  // against the other. Clamping is what made the range "stick" when both thumbs
  // landed on the same value (e.g. 5–5): the top thumb's move got cancelled, so
  // it couldn't be dragged either way. With crossing allowed, the effective
  // bounds are simply min/max of the two, so from any equal position the thumb
  // moves freely in both directions.
  const [confMin, setConfMin] = useState(0);
  const [confMax, setConfMax] = useState(5);
  const confLo = Math.min(confMin, confMax);
  const confHi = Math.max(confMin, confMax);

  // Any non-default filter narrowing WHICH words show (sort doesn't change the set).
  const filtersActive =
    langFilter !== "all" || addedFilter !== "all" || reviewedFilter !== "all" ||
    confLo !== 0 || confHi !== 5;

  // input languages actually present in the current list (for the filter)
  const langsPresent = useMemo(
    () => [...new Set(L.words.map((w) => w.sourceLang))].sort(),
    [L.words]
  );

  const visible = useMemo(() => {
    const byDate = (a: UserWord, b: UserWord) =>
      Date.parse(a.originallyTranslatedDate) - Date.parse(b.originallyTranslatedDate);
    const byConf = (a: UserWord, b: UserWord) => a.confidenceRating - b.confidenceRating;

    const addedCut = periodCutoff(addedFilter);
    const reviewedCut = periodCutoff(reviewedFilter);

    const ws = L.words.filter(
      (w) =>
        (langFilter === "all" || w.sourceLang === langFilter) &&
        Date.parse(w.originallyTranslatedDate) >= addedCut &&
        // a reviewed-date filter excludes never-reviewed words
        (reviewedFilter === "all" ||
          (w.lastReviewedDate != null && Date.parse(w.lastReviewedDate) >= reviewedCut)) &&
        w.confidenceRating >= confLo &&
        w.confidenceRating <= confHi
    );

    const sorted = [...ws];
    switch (sort) {
      case "newest": sorted.sort((a, b) => byDate(b, a)); break;
      case "oldest": sorted.sort(byDate); break;
      // confidence ties break on most-recently-added
      case "conf-asc": sorted.sort((a, b) => byConf(a, b) || byDate(b, a)); break;
      case "conf-desc": sorted.sort((a, b) => byConf(b, a) || byDate(b, a)); break;
    }
    return sorted;
  }, [L.words, langFilter, sort, addedFilter, reviewedFilter, confLo, confHi]);

  // Paged rendering (pure client-side slicing — the whole list is already cached).
  // `page` is 0-indexed. Jump back to the first page whenever the list or a
  // filter/sort CHANGES (a different set) — but NOT when the page itself changes,
  // so switching pages never resets the filters. Also NOT reset while background
  // batches stream in, so the position holds as the cache fills.
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [L.selectedListId, sort, langFilter, addedFilter, reviewedFilter, confMin, confMax]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamp for display so a deletion/streaming change that shrinks the set can't
  // strand us past the last page (the state is corrected by the effect on the next
  // filter change; this keeps the current render valid meanwhile).
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const shown = visible.slice(pageStart, pageStart + PAGE_SIZE);

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
          <span className="lists__count">{L.words.length}</span>
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

      <div className="lists__toolbar">
        <AddWord lookup={L.lookupDictionary} onSave={L.saveSenseToList} />
        <AddCustomWord onAdd={L.addCustomWord} />

        {L.status === "ready" && L.words.length > 0 && (
          <div className="lists__controls">
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

            {langsPresent.length > 1 && (
              <select
                className="select select--sm"
                value={langFilter}
                onChange={(e) => setLangFilter(e.target.value as LangCode | "all")}
                aria-label={t("lists.langFilterAria")}
              >
                <option value="all">{t("lists.allLanguages")}</option>
                {langsPresent.map((code) => (
                  <option key={code} value={code}>
                    {langName(code)}
                  </option>
                ))}
              </select>
            )}

            <PeriodSelect
              label={t("lists.added")}
              value={addedFilter}
              onChange={setAddedFilter}
              ariaLabel={t("lists.addedAria")}
            />
            <PeriodSelect
              label={t("lists.reviewed")}
              value={reviewedFilter}
              onChange={setReviewedFilter}
              ariaLabel={t("lists.reviewedAria")}
            />

            <div className="confrange" title={t("lists.confRangeTitle")}>
              <span className="confrange__label">
                {t("lists.confidenceRange", { min: confLo, max: confHi })}
              </span>
              {/* dual-thumb range: two inputs overlaid on one track */}
              <div className="dualrange">
                <div className="dualrange__track" />
                <div
                  className="dualrange__fill"
                  style={{
                    left: `${(confLo / 5) * 100}%`,
                    right: `${((5 - confHi) / 5) * 100}%`,
                  }}
                />
                {/* No cross-clamping — the thumbs may cross; effective bounds are
                    min/max of the two, so an equal 5–5 (or 0–0) is never stuck. */}
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMin}
                  onChange={(e) => setConfMin(Number(e.target.value))}
                  aria-label={t("lists.confMinAria")}
                />
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMax}
                  onChange={(e) => setConfMax(Number(e.target.value))}
                  aria-label={t("lists.confMaxAria")}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <ErrorText message={L.error} />

      {L.status === "loading" && <p className="review__msg">{t("common.loading")}</p>}

      {L.status === "ready" && L.words.length === 0 && (
        <p className="review__msg">
          {selectedList ? t("lists.emptyList") : t("lists.emptyAll")}
        </p>
      )}

      {L.status === "ready" && L.words.length > 0 && visible.length === 0 && (
        <p className="review__msg">{t("lists.noMatch")}</p>
      )}

      {L.status === "ready" && shown.length > 0 && (
        <ul className="listrows">
          {shown.map((w) => (
            <ListRow
              key={w.userWordId}
              word={w}
              lists={L.lists}
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

      {/* Pager: switches the 200-row window over the already-cached rows (no fetch).
          Only shown when the matches span more than one page. Changing the page
          leaves every filter/sort control untouched. */}
      {L.status === "ready" && pageCount > 1 && (
        <nav className="listrows__pager" aria-label={t("lists.pagerAria")}>
          <button
            className="btn btn--sm"
            onClick={() => setPage((p) => Math.max(0, Math.min(p, pageCount - 1) - 1))}
            disabled={currentPage === 0}
          >
            {t("lists.prevPage")}
          </button>
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
          <button
            className="btn btn--sm"
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
                total: visible.length,
              })
            : filtersActive
              ? t("lists.showingFiltered", { shown: visible.length, total: L.words.length })
              : t("lists.showingTotal", { total: L.words.length })}
          {!L.fullyLoaded && ` · ${t("lists.loadingAll")}`}
        </p>
      )}
    </section>
  );
}
