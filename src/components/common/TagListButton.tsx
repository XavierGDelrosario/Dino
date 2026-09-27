// The row-level "＋ add to list" for a word that is ALREADY in the vocabulary: a ＋
// that opens the shared ListMenu (pick a list, or "New list…" to create one on the
// fly). Shared by the Lists row and the quiz recap so the two can't drift.
//
// Not to be confused with translate/AddToListButton, which SAVES dictionary senses
// into the vocabulary (optionally tagging them) — this one only tags.
import { useRef, useState } from "react";
import type { List } from "../../services/lists";
import { ListMenu } from "./ListMenu";
import { useI18n } from "../../i18n";

export function TagListButton({
  lists,
  onPick,
  onCreate,
}: {
  lists: List[];
  /** File the word into an existing list. The menu closes once it settles. */
  onPick: (listId: string) => unknown;
  /** Create a list (and file the word into it). The menu closes once it settles. */
  onCreate: (name: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="iconbtn listrow__tag"
        onClick={() => setOpen(true)}
        aria-label={t("lists.addToList")}
        title={t("lists.addToList")}
      >
        ＋
      </button>
      {open && (
        <ListMenu
          anchorRef={btnRef}
          lists={lists}
          title={t("lists.addToList")}
          onPick={(listId) => Promise.resolve(onPick(listId)).then(close)}
          onCreate={(name) => onCreate(name).then(close)}
          onClose={close}
        />
      )}
    </>
  );
}
