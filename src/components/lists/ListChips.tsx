// The list selector: ALL + each sub-list as chips, plus inline "＋ New list".
// Presentational — the parent owns the lists and the select/create/delete callbacks.
//
// Deleting a list lives HERE rather than in the header bar: the chip row is where a
// list is chosen, so it's also where it's discarded. The ✕ rides the top-right
// corner of the SELECTED chip only — one target at a time, so the row can't be
// mis-clicked into deleting a list you were merely reading past.
import { useLayoutEffect, useRef, useState } from "react";
import type { List } from "../../services/lists";
import { useI18n } from "../../i18n";
import { XIcon } from "../common/icons";
import "./lists.css";

export function ListChips({
  lists,
  selectedListId,
  onSelect,
  onCreate,
  onDelete,
}: {
  lists: List[];
  selectedListId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onDelete: (list: List) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // WHY THIS ISN'T `autoFocus`. The chip row scrolls sideways, and `autoFocus` hands
  // the scrolling of it to the browser — which brings a focused element into view by
  // CENTRING it in its scroll container. So opening the name field swept the row
  // sideways and parked the field in the middle of it, with the lists you were
  // choosing between pushed off both edges, for a field that had simply replaced a
  // chip sitting still at the end of the row.
  //
  // Focus without scrolling, then place the row ourselves. .chips__new is always the
  // LAST item, so the far right is exactly where the ＋ New list chip just was: the
  // field appears where the button was, and a row short enough not to scroll doesn't
  // move at all (scrollLeft clamps to 0). Layout effect, so it lands before paint.
  useLayoutEffect(() => {
    if (!creating) return;
    inputRef.current?.focus({ preventScroll: true });
    const row = rowRef.current;
    if (row) row.scrollLeft = row.scrollWidth;
  }, [creating]);

  return (
    <div className="chips" ref={rowRef}>
      <button
        className={`chip ellipsis${selectedListId === null ? " chip--active" : ""}`}
        onClick={() => onSelect(null)}
      >
        {t("lists.allChip")}
      </button>
      {lists.map((l) => (
        // A chip + its own ✕ can't be one <button> (no nested buttons), so the pair
        // shares a positioned wrapper and the ✕ hangs off the corner.
        <span className="chips__item" key={l.listId}>
          <button
            className={`chip ellipsis${selectedListId === l.listId ? " chip--active" : ""}`}
            onClick={() => onSelect(l.listId)}
            // The chip ellipsises a long name, so the full one lives on hover.
            title={l.listName}
          >
            {l.listName}
          </button>
          {selectedListId === l.listId && (
            <button
              className="chips__del"
              onClick={() => onDelete(l)}
              title={t("lists.deleteListTitle")}
              aria-label={t("lists.deleteListTitle")}
            >
              <XIcon size={11} />
            </button>
          )}
        </span>
      ))}

      {creating ? (
        <span className="chips__new">
          <input
            ref={inputRef}
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("lists.newListPlaceholder")}
            aria-label={t("lists.newListAria")}
          />
          <button
            className="iconbtn"
            onClick={() => {
              const v = name.trim();
              if (v) onCreate(v);
              setName("");
              setCreating(false);
            }}
            title={t("common.create")}
          >
            ✓
          </button>
          <button
            className="iconbtn"
            onClick={() => {
              setName("");
              setCreating(false);
            }}
            title={t("common.cancel")}
          >
            ✕
          </button>
        </span>
      ) : (
        <button className="chip chip--ghost" onClick={() => setCreating(true)}>
          {t("lists.newList")}
        </button>
      )}
    </div>
  );
}
