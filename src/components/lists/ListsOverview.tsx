// The lists INDEX — a vertical row per list, and the Lists tab's management surface.
//
// It replaces the chip row as the way IN. Chips are a horizontal scroller: cramped on a
// phone, and every list added makes them worse, because the cost of finding one grows
// while the space each gets shrinks. A vertical list has the opposite property — it
// grows down, which phones are built for — and has room both to say something about
// each entry and to hold the controls belonging to the list ITSELF (rename, delete,
// create) rather than to the words inside it.
//
// Still free of the word UI: no filter menu, no add-word form, no word table, no pager.
// This screen answers "which list" and manages the lists; everything that operates on
// WORDS lives one tap deeper, where a list is actually selected.
//
// It loads NO WORDS — not even for the summary. list_overview() (migrations 20260773 +
// 20260774) does the counting in SQL, so the page costs the same for a 50-word
// vocabulary and a 50,000-word one. The summary panel is built from those aggregates by
// summarizeAggregates, which reuses the reader's own bar builders, so the index and the
// quiz recap are the same chart rather than two that merely resemble each other.
import { useMemo, useState } from "react";
import { SortControls, type SortDir } from "../common/SortControls";
import { Loading } from "../common/Loading";
import { AnalyzeInfographic } from "../common/AnalyzeInfographic";
import { PencilIcon, XIcon } from "../common/icons";
import { summarizeAggregates } from "../../services/analyze/summarize";
import { useI18n } from "../../i18n";
import type { ListOverview } from "../../services/lists";
import type { LangCode } from "../../services/language";
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

/** Inline name field with ✓/✕ — the same shape ListChips uses for "New list", so
 *  creating and renaming a list are one gesture rather than two conventions. */
function NameField({
  initial,
  onCommit,
  onClose,
}: {
  initial?: string;
  onCommit: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial ?? "");
  return (
    <span className="listcard__namefield">
      <input
        className="input input--sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("lists.newListPlaceholder")}
        aria-label={t("lists.newListAria")}
      />
      <button
        className="iconbtn"
        title={t("common.create")}
        onClick={() => {
          const v = name.trim();
          if (v) onCommit(v);
          onClose();
        }}
      >
        ✓
      </button>
      <button className="iconbtn" title={t("common.cancel")} onClick={onClose}>
        ✕
      </button>
    </span>
  );
}

function ListCard({
  row,
  onOpen,
  onRename,
  onDelete,
}: {
  row: ListOverview;
  onOpen: (listId: string | null) => void;
  onRename: (listId: string, name: string) => void;
  onDelete: (row: ListOverview) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(false);
  const isAll = row.listId === null;

  // Built ONLY while the panel is open. The bars are cheap, but there is no reason to
  // compute every list's on every render of the index — the same rule ListView's own
  // summary panel follows.
  const data = useMemo(
    () =>
      summary
        ? summarizeAggregates({
            total: row.wordCount,
            confidence: row.confidence,
            freq: row.freq,
            band: row.band,
            mainLang: row.mainLang as LangCode | null,
          })
        : null,
    [summary, row],
  );

  return (
    <li className={`listcard${isAll ? " listcard--all" : ""}`}>
      {/* OUTSIDE the head row, as a corner badge — the same trick .chips__del uses.
          In the row it was a third thing competing for width with the name; pinned to
          the corner it takes no layout at all, so the name gets the whole line back. */}
      {!isAll && !editing && (
        <button
          className="listcard__del"
          onClick={() => onDelete(row)}
          title={t("lists.deleteListTitle")}
          aria-label={t("lists.deleteListTitle")}
        >
          <XIcon size={11} />
        </button>
      )}
      <div className="listcard__head">
        {editing && row.listId ? (
          <NameField
            initial={row.listName ?? ""}
            onCommit={(n) => onRename(row.listId!, n)}
            onClose={() => setEditing(false)}
          />
        ) : (
          <>
            {/* The NAME is the target, not the whole card: the card also carries three
                controls, and a <button> cannot contain buttons. */}
            <button className="listcard__open" onClick={() => onOpen(row.listId)}>
              <span className="listcard__name ellipsis">{row.listName ?? t("lists.allWords")}</span>
            </button>
            {/* ALL is virtual — there is no `lists` row to rename or delete, which is
                why it carries neither control rather than carrying disabled ones. */}
            {!isAll && (
              <button
                className="iconbtn listcard__edit"
                onClick={() => setEditing(true)}
                title={t("lists.renameList")}
                aria-label={t("lists.renameList")}
              >
                <PencilIcon size={13} />
              </button>
            )}
            <span className="listcard__count">{row.wordCount}</span>
          </>
        )}
      </div>

      {/* A TOGGLE, not always-on: three bars per row across a dozen lists is a wall of
          charts, and this screen's job is "which list". Absent for an empty list, which
          has nothing to chart. */}
      {row.wordCount > 0 && (
        <button
          className={`listcard__summary${summary ? " listcard__summary--on" : ""}`}
          onClick={() => setSummary((v) => !v)}
          aria-expanded={summary}
          title={t("lists.summaryTitle")}
        >
          {t("lists.summaryBtn")}
        </button>
      )}
      {summary && data && (
        <div className="listcard__panel">
          <AnalyzeInfographic data={data} />
        </div>
      )}
    </li>
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
  onRename,
  onDelete,
  onCreate,
}: {
  rows: ListOverview[];
  loading: boolean;
  axis: ListSortAxis;
  dir: SortDir;
  onAxis: (a: ListSortAxis) => void;
  onDir: (d: SortDir) => void;
  /** Open a list (null = ALL) in the word table. */
  onOpen: (listId: string | null) => void;
  onRename: (listId: string, name: string) => void;
  onDelete: (row: ListOverview) => void;
  onCreate: (name: string) => void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
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
          <ListCard
            key={r.listId ?? "__all"}
            row={r}
            onOpen={onOpen}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </ul>

      {/* Create sits at the BOTTOM, after the lists. It is the least-used control on a
          screen whose job is picking one of the lists you already have, and putting it
          last means the row you reach for first never shifts as lists accumulate. */}
      {creating ? (
        <div className="listsoverview__create">
          <NameField onCommit={onCreate} onClose={() => setCreating(false)} />
        </div>
      ) : (
        <button
          className="chip ellipsis chip--ghost listsoverview__add"
          onClick={() => setCreating(true)}
        >
          {t("lists.newList")}
        </button>
      )}
    </section>
  );
}
