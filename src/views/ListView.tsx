// The Lists screen: list chips (ALL + sub-lists), the words in the selected list
// with sort/filter controls, and the add/review actions. Orchestration only —
// each piece (chips, add forms, period filter, word row) is its own component;
// this view owns the filter state and wires the useLists callbacks.
//
// "ALL" is the virtual whole-vocabulary view (not a stored list). Adding a word
// while a sub-list is selected also tags it into that sub-list.
import { useMemo, useState } from "react";
import { useLists } from "../hooks/useLists";
import { ListRow } from "../components/lists/ListRow";
import { ListChips } from "../components/lists/ListChips";
import { AddWord } from "../components/lists/AddWord";
import { AddCustomWord } from "../components/lists/AddCustomWord";
import { PeriodSelect, periodCutoff, type DatePeriod } from "../components/lists/PeriodSelect";
import { targetOptions, type LangCode } from "../services/language";
import { useI18n } from "../i18n";
import type { UserWord } from "../services/words/userWords";
import "../components/lists/lists.css";

type SortBy = "newest" | "oldest" | "conf-asc" | "conf-desc";

const langName = (code: string) =>
  targetOptions().find((o) => o.code === code)?.name ?? code;

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
  const [confMin, setConfMin] = useState(0);
  const [confMax, setConfMax] = useState(5);

  // Any non-default filter narrowing WHICH words show (sort doesn't change the set).
  const filtersActive =
    langFilter !== "all" || addedFilter !== "all" || reviewedFilter !== "all" ||
    confMin !== 0 || confMax !== 5;

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
        w.confidenceRating >= confMin &&
        w.confidenceRating <= confMax
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
  }, [L.words, langFilter, sort, addedFilter, reviewedFilter, confMin, confMax]);

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
          <span className="lists__count">{visible.length}</span>
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
                {t("lists.confidenceRange", { min: confMin, max: confMax })}
              </span>
              {/* dual-thumb range: two inputs overlaid on one track */}
              <div className="dualrange">
                <div className="dualrange__track" />
                <div
                  className="dualrange__fill"
                  style={{
                    left: `${(confMin / 5) * 100}%`,
                    right: `${((5 - confMax) / 5) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMin}
                  onChange={(e) => setConfMin(Math.min(Number(e.target.value), confMax))}
                  aria-label={t("lists.confMinAria")}
                />
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMax}
                  onChange={(e) => setConfMax(Math.max(Number(e.target.value), confMin))}
                  aria-label={t("lists.confMaxAria")}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {L.error && <pre className="review__error">{L.error}</pre>}

      {L.status === "loading" && <p className="review__msg">{t("common.loading")}</p>}

      {L.status === "ready" && L.words.length === 0 && (
        <p className="review__msg">
          {selectedList ? t("lists.emptyList") : t("lists.emptyAll")}
        </p>
      )}

      {L.status === "ready" && L.words.length > 0 && visible.length === 0 && (
        <p className="review__msg">{t("lists.noMatch")}</p>
      )}

      {L.status === "ready" && visible.length > 0 && (
        <ul className="listrows">
          {visible.map((w) => (
            <ListRow
              key={w.userWordId}
              word={w}
              lists={L.lists}
              onEdit={(translation) => L.editWord(w.userWordId, translation)}
              onDelete={() => L.deleteWord(w.userWordId)}
              onTag={(listId) => L.tagWord(w.userWordId, listId)}
              onRemoveFromList={
                L.selectedListId ? () => L.untagWord(w.userWordId) : undefined
              }
            />
          ))}
        </ul>
      )}

      {/* Load-more: the reads are paged, so a long vocabulary isn't pulled at once.
          Shown whenever more rows exist (filters apply client-side to loaded ones). */}
      {L.status === "ready" && L.hasMore && (
        <div className="listrows__more">
          <button className="btn" onClick={L.loadMore} disabled={L.loadingMore}>
            {L.loadingMore ? t("common.loading") : t("common.loadMore")}
          </button>
        </div>
      )}
    </section>
  );
}
