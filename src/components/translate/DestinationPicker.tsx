// "Add to: [ALL | a sub-list | ＋ New list…]" — the destination every add button
// in the Translate view saves to. Presentational: the parent owns the lists and
// the select/create callbacks.
import { useState } from "react";
import type { List } from "../../services/lists";
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

  return (
    <div className="destpicker">
      <span className="destpicker__label">Add to:</span>
      {creating ? (
        <>
          <input
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New list name"
            aria-label="New list name"
            autoFocus
          />
          <button
            className="iconbtn"
            title="Create list"
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
            title="Cancel"
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
          aria-label="Destination list"
        >
          <option value="">ALL (everything)</option>
          {lists.map((l) => (
            <option key={l.listId} value={l.listId}>
              {l.listName}
            </option>
          ))}
          <option value="__new__">＋ New list…</option>
        </select>
      )}
    </div>
  );
}
