// The list selector: ALL + each sub-list as chips, plus inline "＋ New list".
// Presentational — the parent owns the lists and the select/create callbacks.
import { useState } from "react";
import type { List } from "../../services/lists";
import "./lists.css";

export function ListChips({
  lists,
  selectedListId,
  onSelect,
  onCreate,
}: {
  lists: List[];
  selectedListId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="chips">
      <button
        className={`chip${selectedListId === null ? " chip--active" : ""}`}
        onClick={() => onSelect(null)}
      >
        ALL
      </button>
      {lists.map((l) => (
        <button
          key={l.listId}
          className={`chip${selectedListId === l.listId ? " chip--active" : ""}`}
          onClick={() => onSelect(l.listId)}
        >
          {l.listName}
        </button>
      ))}

      {creating ? (
        <span className="chips__new">
          <input
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="List name"
            aria-label="New list name"
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
            title="Create"
          >
            ✓
          </button>
          <button
            className="iconbtn"
            onClick={() => {
              setName("");
              setCreating(false);
            }}
            title="Cancel"
          >
            ✕
          </button>
        </span>
      ) : (
        <button className="chip chip--ghost" onClick={() => setCreating(true)}>
          ＋ New list
        </button>
      )}
    </div>
  );
}
