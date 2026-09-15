// The list selector: ALL + each sub-list as chips, plus inline "＋ New list".
// Presentational — the parent owns the lists and the select/create/delete callbacks.
//
// Deleting a list lives HERE rather than in the header bar: the chip row is where a
// list is chosen, so it's also where it's discarded. The ✕ rides the top-right
// corner of the SELECTED chip only — one target at a time, so the row can't be
// mis-clicked into deleting a list you were merely reading past.
import { useState } from "react";
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

  return (
    <div className="chips">
      <button
        className={`chip${selectedListId === null ? " chip--active" : ""}`}
        onClick={() => onSelect(null)}
      >
        {t("lists.allChip")}
      </button>
      {lists.map((l) => (
        // A chip + its own ✕ can't be one <button> (no nested buttons), so the pair
        // shares a positioned wrapper and the ✕ hangs off the corner.
        <span className="chips__item" key={l.listId}>
          <button
            className={`chip${selectedListId === l.listId ? " chip--active" : ""}`}
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
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("lists.newListPlaceholder")}
            aria-label={t("lists.newListAria")}
            autoFocus
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
