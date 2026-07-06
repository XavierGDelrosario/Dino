// Add button with a two-stage interaction (used for a single word AND "Add all"):
//   1. first click  → adds to ALL (the vocabulary), flashes ✓ for ~1s, reverts to +
//   2. next click   → opens a menu of sub-lists + "New list…" to ALSO file it there
// Adding to a list is the same idempotent save with a listId, so the word is in
// ALL after step 1 and just gets tagged in step 2. The sub-list menu (incl. the
// create-a-list flow) is the shared ListMenu, so it matches the list view + quiz.
import { useRef, useState } from "react";
import type { List } from "../../services/lists";
import type { Word } from "../../services/words/repository";
import { ListMenu } from "../common/ListMenu";
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
  const { t } = useI18n();
  // The set we're operating on, frozen at the first add (the live `words` empties
  // once they're saved, but the menu still needs to tag the originals).
  const frozen = useRef<Word[]>(words);
  const btnRef = useRef<HTMLButtonElement>(null);

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
      flashCheck();
    } catch {
      setPhase("menu");
    }
  };

  const createAndAdd = async (name: string) => {
    setPhase("busy");
    try {
      const id = await onCreateList(name);
      await onAdd(frozen.current, id);
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
        ref={btnRef}
        className={`${className}${phase === "armed" ? " add--armed" : ""}`}
        disabled={disabled}
        onClick={() => (phase === "armed" ? setPhase("menu") : addToAll())}
      >
        {label}
      </button>

      {phase === "menu" && (
        <ListMenu
          anchorRef={btnRef}
          lists={lists}
          title={t("add.menuTitle")}
          onPick={addToList}
          onCreate={createAndAdd}
          onClose={() => setPhase("armed")}
        />
      )}
    </div>
  );
}
