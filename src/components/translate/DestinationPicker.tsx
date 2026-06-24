// "Add to: [ALL | a sub-list | ＋ New list…]" — the destination every add button
// in the Translate view saves to. Presentational: the parent owns the lists and
// the select/create callbacks.
import { useState } from "react";
import type { List } from "../../services/lists";
import { useI18n } from "../../i18n";
import "./translate.css";

export function DestinationPicker({
  lists,
  destListId,
  onSelect,
  onCreate,
}: {
  lists: List[];
  destListId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const { t } = useI18n();

  return (
    <div className="destpicker">
      <span className="destpicker__label">{t("dest.addTo")}</span>
      {creating ? (
        <>
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
            title={t("common.create")}
            onClick={() => {
              if (name.trim()) onCreate(name);
              setName("");
              setCreating(false);
            }}
          >
            ✓
          </button>
          <button
            className="iconbtn"
            title={t("common.cancel")}
            onClick={() => {
              setName("");
              setCreating(false);
            }}
          >
            ✕
          </button>
        </>
      ) : (
        <select
          className="select select--sm"
          value={destListId ?? ""}
          onChange={(e) => {
            if (e.target.value === "__new__") setCreating(true);
            else onSelect(e.target.value || null);
          }}
          aria-label={t("dest.all")}
        >
          <option value="">{t("dest.all")}</option>
          {lists.map((l) => (
            <option key={l.listId} value={l.listId}>
              {l.listName}
            </option>
          ))}
          <option value="__new__">{t("add.newListEllipsis")}</option>
        </select>
      )}
    </div>
  );
}
