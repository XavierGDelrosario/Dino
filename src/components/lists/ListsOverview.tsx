// The lists INDEX — a vertical row per list, and the landing state of the Lists tab.
//
// It replaces the chip row as the way IN. Chips are a horizontal scroller: cramped on a
// phone, and every list added makes them worse, because the cost of finding one grows
// while the space each gets shrinks. A vertical list has the opposite property — it
// grows down, which phones are built for — and has room to say something about each
// entry instead of just naming it.
//
// Deliberately free of the word UI: no filter menu, no add form, no word table, no
// pager. This screen answers "which list" and nothing else; everything that operates on
// WORDS lives one tap deeper, where a list is actually selected.
//
// It loads NO WORDS. Counts and the confidence bar come from list_overview() (migration
// 20260773), a single aggregate query, so this page costs the same for a 50-word
// vocabulary and a 50,000-word one. That is the whole reason the summary here is a bar
// and not the AnalyzeInfographic: the real summary walks every row (summarizeUserWords),
// so it stays behind the drill-in where those rows have been loaded anyway.
import { useMemo } from "react";
import { SortControls, type SortDir } from "../common/SortControls";
import { Loading } from "../common/Loading";
import { useI18n } from "../../i18n";
import type { ListOverview } from "../../services/lists";
import "./lists.css";

/** name = alphabetical · created = the list itself · added = its most recent word. */
export type ListSortAxis = "name" | "created" | "added";

/** Newest-first for the two date axes, A→Z for name. */
function sortOverviews(
  rows: ListOverview[],
  axis: ListSortAxis,
  dir: SortDir,
): ListOverview[] {
  // "most" is the NEWEST/Z–A end of every axis here, so it sorts DESCENDING — the
  // opposite sign to a numeric "most" like confidence, where more means a bigger value.
  const sign = dir === "most" ? -1 : 1;
  // ALL is pinned to the top whatever the axis: it is the whole vocabulary rather than
  // one list among the others, and hunting for it under a sort would be a regression on
  // the chip row, where it was always first.
  const all = rows.filter((r) => r.listId === null);
  const lists = [...rows.filter((r) => r.listId !== null)];
  // A never-used list has no date on the axis being sorted. It sorts LAST in both
  // directions rather than being treated as epoch-zero, which would bury real lists
  // under every empty one the moment you flipped the direction.
  const time = (v: string | null) => (v == null ? null : Date.parse(v));
  lists.sort((a, b) => {
    if (axis === "name") {
      return (a.listName ?? "").localeCompare(b.listName ?? "") * sign;
    }
    const av = time(axis === "created" ? a.createdAt : a.lastWordAddedAt);
    const bv = time(axis === "created" ? b.createdAt : b.lastWordAddedAt);
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    return (av - bv) * sign;
  });
  return [...all, ...lists];
}

/** The six confidence buckets as one bar. Renders nothing for an empty list — a bar of
 *  pure background reads as "all at zero" rather than "nothing here yet". */
function ConfidenceBar({ counts, total }: { counts: number[]; total: number }) {
  const { t } = useI18n();
  if (total === 0) return null;
  return (
    <span className="listcard__bar" aria-label={t("lists.overviewBarAria")}>
      {counts.map((n, i) =>
        n === 0 ? null : (
          <span
            key={i}
            className="listcard__seg"
            // The SAME red→green ramp the reader colours words with and the charts
            // use, so a bar segment and the word it counts can never disagree.
            style={{ width: `${(n / total) * 100}%`, background: `var(--conf-${i})` }}
          />
        ),
      )}
    </span>
  );
}

export function ListsOverview({
  rows,
  loading,
  axis,
  dir,
  onAxis,
  onDir,
  onOpen,
}: {
  rows: ListOverview[];
  loading: boolean;
  axis: ListSortAxis;
  dir: SortDir;
  onAxis: (a: ListSortAxis) => void;
  onDir: (d: SortDir) => void;
  /** Open a list (null = ALL) in the word table. */
  onOpen: (listId: string | null) => void;
}) {
  const { t } = useI18n();
  const sorted = useMemo(() => sortOverviews(rows, axis, dir), [rows, axis, dir]);

  return (
    <section className="listsoverview">
      <div className="listsoverview__bar">
        <SortControls
          label={t("sort.label")}
          flipLabel={t("sort.flip")}
          value={axis}
          dir={dir}
          onValue={(v) => onAxis(v as ListSortAxis)}
          onDir={onDir}
          options={[
            { value: "added", least: t("sort.addedOldest"), most: t("sort.addedNewest") },
            { value: "created", least: t("sort.createdOldest"), most: t("sort.createdNewest") },
            { value: "name", least: t("sort.nameAZ"), most: t("sort.nameZA") },
          ]}
        />
      </div>

      {loading && rows.length === 0 && (
        <p className="review__msg">
          <Loading text={t("common.loading")} />
        </p>
      )}

      <ul className="listsoverview__rows">
        {sorted.map((r) => (
          <li key={r.listId ?? "__all"}>
            <button
              type="button"
              className={`listcard${r.listId === null ? " listcard--all" : ""}`}
              onClick={() => onOpen(r.listId)}
            >
              <span className="listcard__name">{r.listName ?? t("lists.allWords")}</span>
              <span className="listcard__count">{r.wordCount}</span>
              <ConfidenceBar counts={r.confidence} total={r.wordCount} />
            </button>
          </li>
        ))}
      </ul>

      {/* Only once the fetch has settled: an empty <ul> during the first load would
          otherwise flash "no lists yet" at a user who has plenty. ALL is always a row,
          so `length <= 1` — not 0 — is what "no lists" actually looks like here. */}
      {!loading && sorted.length <= 1 && (
        <p className="review__msg">{t("lists.overviewEmpty")}</p>
      )}
    </section>
  );
}
