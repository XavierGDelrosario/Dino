// The in-depth summary's vocabulary table. Rows are formatted like a Lists row
// (headword + reading · meanings · the shared "?" info panel · confidence dots),
// with ONE article addition: a ×N occurrence chip (how often the word appears here).
//
// Controls mirror Lists exactly: a status segment (All / New / Known), the SAME
// filter surface (funnel + panel, minus the vocab-history axes), the SAME sort
// control (axis dropdown + least⇄most switch), and the SAME pager over the rows.
// Data + ordering are pure (services/analyze/wordlist).
import { useEffect, useMemo, useState } from "react";
import {
  sortWords,
  filterByStatus,
  type ArticleWord,
  type SortAxis,
  type SortDir,
  type StatusFilter,
} from "../../services/analyze/wordlist";
import { FilterButton, FilterPanel } from "../lists/FilterMenu";
import {
  makeMatcher,
  NO_FILTERS,
  type WordFilters,
  type FilterTarget,
} from "../../services/words/filters";
import { partOfSpeechCategory, POS_CATEGORIES, type PosCategory } from "../../services/language";
import { SortControls, type SortOption } from "../common/SortControls";
import { Pager } from "../common/Pager";
import { PAGE_SIZE } from "../../lib/pagination";
import { WordInfoButton } from "../common/WordInfo";
import { AddToListButton } from "../translate/AddToListButton";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { useI18n } from "../../i18n";
import "../lists/lists.css"; // .listrow* + .dots/.dot + .filtermenu* (match the Lists surface)
import "./article.css";

const STATUSES: StatusFilter[] = ["all", "new", "known"];

/** ArticleWord → the shape the shared filter matcher reads (no vocab dates here). */
function asFilterTarget(r: ArticleWord): FilterTarget {
  return {
    sourceLang: r.primary.sourceLang,
    proficiencyBand: r.primary.proficiencyBand,
    partOfSpeech: r.primary.partOfSpeech,
    frequency: r.primary.frequency,
    confidenceRating: r.confidence,
    originallyTranslatedDate: "", // history axes are hidden on this surface
    lastReviewedDate: null,
  };
}

/** The Lists confidence UI: five dots filled to the rating. */
function ConfidenceDots({ rating }: { rating: number }) {
  const { t } = useI18n();
  return (
    <span className="dots" aria-label={t("lists.confidenceOf", { n: rating })}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`dot${i < rating ? " dot--on" : ""}`} />
      ))}
    </span>
  );
}

function ArticleRow({
  row,
  lists,
  onAdd,
  onCreateList,
}: {
  row: ArticleWord;
  lists: List[];
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
}) {
  const { t } = useI18n();
  const meanings = row.primary.translation
    .split(";")
    .map((m) => m.trim())
    .filter(Boolean);

  return (
    <li className="listrow">
      <div className="listrow__header">
        <span className="listrow__head">
          {row.headword}
          {row.reading && row.reading !== row.headword && (
            <em className="listrow__reading">{row.reading}</em>
          )}
        </span>

        <div className="listrow__meta">
          <WordInfoButton word={row.primary} />
          {/* Frequency — the article-only addition: times this word appears here. */}
          <span className="awl__freq" title={t("media.occurrences", { n: row.occurrences })}>
            ×{row.occurrences}
          </span>
          {row.status === "known" ? (
            <ConfidenceDots rating={row.confidence} />
          ) : (
            <AddToListButton
              words={row.senses}
              lists={lists}
              label={t("media.add")}
              onAdd={onAdd}
              onCreateList={onCreateList}
              className="iconbtn listrow__tag"
            />
          )}
        </div>
      </div>

      <div className="listrow__meaning">
        {meanings.map((m, i) => (
          <span key={i} className="listrow__meaning-line">
            {m}
            {i === 0 && row.primary.translationReading && (
              <em className="listrow__reading">{row.primary.translationReading}</em>
            )}
          </span>
        ))}
      </div>
    </li>
  );
}

export function ArticleWordList({
  rows,
  lists,
  onAdd,
  onCreateList,
}: {
  rows: ArticleWord[];
  lists: List[];
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [axis, setAxis] = useState<SortAxis>("recommended");
  const [dir, setDir] = useState<SortDir>("least");
  const [filters, setFilters] = useState<WordFilters>(NO_FILTERS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [page, setPage] = useState(0);

  // The attribute values present in this article — the filter only offers a
  // language / word class you could actually match (same rule as Lists).
  const langsPresent = useMemo(
    () => [...new Set(rows.map((r) => r.primary.sourceLang))].sort(),
    [rows],
  );
  const posPresent = useMemo(() => {
    const present = new Set(
      rows
        .map((r) => partOfSpeechCategory(r.primary.partOfSpeech))
        .filter((c): c is PosCategory => c != null),
    );
    return POS_CATEGORIES.filter((c) => present.has(c));
  }, [rows]);

  const shown = useMemo(() => {
    const matchesFilter = makeMatcher(filters);
    const base = filterByStatus(rows, status).filter((r) => matchesFilter(asFilterTarget(r)));
    return sortWords(base, axis, dir);
  }, [rows, status, filters, axis, dir]);

  // Back to the first page whenever the set or its order changes.
  useEffect(() => setPage(0), [rows, status, filters, axis, dir]);
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = shown.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const sortOptions: SortOption[] = [
    { value: "recommended", directional: false, least: t("media.sortRecommended"), most: t("media.sortRecommended") },
    { value: "common", least: t("sort.leastCommon"), most: t("sort.mostCommon") },
    { value: "confident", least: t("sort.leastConfident"), most: t("sort.mostConfident") },
    { value: "difficult", least: t("sort.leastDifficult"), most: t("sort.mostDifficult") },
    { value: "occurrences", least: t("media.leastOccurrences"), most: t("media.mostOccurrences") },
  ];

  return (
    <div className="awl">
      <div className="awl__controls">
        <div className="awl__status" role="group" aria-label={t("media.filterStatus")}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`awl__seg${status === s ? " is-active" : ""}`}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {t(`media.filter_${s}` as "media.filter_all")}
            </button>
          ))}
        </div>

        <div className="awl__tools">
          <FilterButton filters={filters} open={panelOpen} onToggle={() => setPanelOpen((v) => !v)} />
          <SortControls
            label={t("sort.label")}
            flipLabel={t("sort.flip")}
            options={sortOptions}
            value={axis}
            dir={dir}
            onValue={(v) => setAxis(v as SortAxis)}
            onDir={setDir}
          />
        </div>
      </div>

      {panelOpen && (
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onClose={() => setPanelOpen(false)}
          langsPresent={langsPresent}
          posPresent={posPresent}
          showHistory={false}
        />
      )}

      {shown.length === 0 ? (
        <p className="review__msg awl__empty">{t("media.noWordsFilter")}</p>
      ) : (
        <>
          <ul className="awl__list">
            {pageRows.map((r) => (
              <ArticleRow
                key={r.primary.wordId}
                row={r}
                lists={lists}
                onAdd={onAdd}
                onCreateList={onCreateList}
              />
            ))}
          </ul>
          <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />
        </>
      )}
    </div>
  );
}
