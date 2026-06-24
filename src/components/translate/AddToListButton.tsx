// Add button with a two-stage interaction (used for a single word AND "Add all"):
//   1. first click  → adds to ALL (the vocabulary), flashes ✓ for ~1s, reverts to +
//   2. next click   → opens a menu of sub-lists + "New list…" to ALSO file it there
// Adding to a list is the same idempotent save with a listId, so the word is in
// ALL after step 1 and just gets tagged in step 2.
import { useRef, useState } from "react";
import type { List } from "../../services/lists";
import type { Word } from "../../services/words/repository";
import { useI18n } from "../../i18n";
import "./translate.css";

const CHECK_MS = 1000;

type Phase = "idle" | "busy" | "check" | "armed" | "menu";

export function AddToListButton({
  words,
  lists,
  label,
  alreadyAdded = false,
  disabled = false,
  className = "",
  onAdd,
  onCreateList,
}: {
  /** The word(s) this button adds — one sense, or every new word for "Add all". */
  words: Word[];
  lists: List[];
  /** Button face in idle/armed (e.g. "+ Add" or "+ Add all 3 new words"). */
  label: string;
  /** Start armed (already in ALL) → a click opens the list menu directly. */
  alreadyAdded?: boolean;
  disabled?: boolean;
  className?: string;
  /** Add the words to ALL (no listId) or tag them into a sub-list. */
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  /** Create a sub-list, returning its id (then the words are tagged into it). */
  onCreateList: (name: string) => Promise<string>;
}) {
  const [phase, setPhase] = useState<Phase>(alreadyAdded ? "armed" : "idle");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const { t } = useI18n();
  // The set we're operating on, frozen at the first add (the live `words` empties
  // once they're saved, but the menu still needs to tag the originals).
  const frozen = useRef<Word[]>(words);

  const flashCheck = () => {
    setPhase("check");
    setTimeout(() => setPhase("armed"), CHECK_MS);
  };

  const addToAll = async () => {
    frozen.current = words;
    setPhase("busy");
    try {
      await onAdd(words);
      flashCheck();
    } catch {
      setPhase("idle");
    }
  };

  const addToList = async (listId: string) => {
    setPhase("busy");
    try {
      await onAdd(frozen.current, listId);
      setCreating(false);
      setName("");
      flashCheck();
    } catch {
      setPhase("menu");
    }
  };

  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    setPhase("busy");
    try {
      const id = await onCreateList(n);
      await onAdd(frozen.current, id);
      setCreating(false);
      setName("");
      flashCheck();
    } catch {
      setPhase("menu");
    }
  };

  if (phase === "check") {
    return <button className={`${className} add--done`} disabled aria-label={t("add.addedAria")}>✓</button>;
  }
  if (phase === "busy") {
    return <button className={className} disabled>…</button>;
  }

  return (
    <div className="addwrap">
      <button
        className={`${className}${phase === "armed" ? " add--armed" : ""}`}
        disabled={disabled}
        onClick={() => (phase === "armed" ? setPhase("menu") : addToAll())}
      >
        {label}
      </button>

      {phase === "menu" && (
        <div className="addmenu" role="menu">
          <div className="addmenu__title">{t("add.menuTitle")}</div>
          {lists.map((l) => (
            <button key={l.listId} className="addmenu__item" onClick={() => addToList(l.listId)}>
              {l.listName}
            </button>
          ))}
          {creating ? (
            <div className="addmenu__create">
              <input
                className="input input--sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("lists.newListPlaceholder")}
                aria-label={t("lists.newListAria")}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
              />
              <button className="iconbtn" title={t("common.create")} onClick={createAndAdd}>✓</button>
              <button
                className="iconbtn"
                title={t("common.cancel")}
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <button className="addmenu__item addmenu__new" onClick={() => setCreating(true)}>
              {t("add.newListEllipsis")}
            </button>
          )}
          <button className="addmenu__close" onClick={() => setPhase("armed")}>
            {t("add.done")}
          </button>
        </div>
      )}
    </div>
  );
}
