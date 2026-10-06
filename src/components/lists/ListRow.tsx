// One word in a list, on the shared <WordRow>: headword (+reading) · meaning ·
// confidence · row actions.
// Editing the meaning is inline (setting custom_translation = an override on the
// SAME user_words row, never a new one). "Add to list" tags it into a sub-list;
// "Remove from list" only shows when viewing a sub-list (un-tags, keeps the word
// in the vocabulary); the trash deletes it from the vocabulary entirely.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { UserWord } from "../../services/words/userWords";
import type { List } from "../../services/lists";
import { TagListButton } from "../common/TagListButton";
import { WordRow } from "../common/WordRow";
import { PencilIcon, TrashIcon } from "../common/icons";
import { isMeaningEdited } from "../../services/words/userWords";
import { WordInfoButton } from "../common/WordInfo";
import { ConfidenceDots } from "../common/ConfidenceDots";
import { useI18n, type Locale } from "../../i18n";
import "./lists.css";

/** ISO timestamp → short readable date in the UI locale, or "never" for null. */
function fmtDate(iso: string | null, locale: Locale, never: string): string {
  if (!iso) return never;
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ListRow({
  word,
  lists,
  onEdit,
  onRevert,
  onDelete,
  onTag,
  onCreateList,
  onForgot,
  onRemoveFromList,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  word: UserWord;
  lists: List[];
  onEdit: (translation: string) => void;
  /** Drop an edited meaning for the dictionary's. Offered only on a word whose
   *  meaning HAS been edited; omit and the editor has no "Revert to original". */
  onRevert?: () => void;
  onDelete: () => void;
  onTag: (listId: string) => void;
  /** Create a sub-list and tag this word into it (the on-the-fly "New list…").
   *  Only completion is used (the menu closes); the resolved value is ignored. */
  onCreateList: (name: string) => Promise<unknown>;
  /** "Forgot": drop this word one confidence bucket. Wired to the confidence dots,
   *  which become the trigger for it; omit and they stay inert text. */
  onForgot?: () => Promise<unknown>;
  /** Present only when viewing a sub-list (enables un-tagging). */
  onRemoveFromList?: () => void;
  /** Select mode (the Lists "Select" toggle): the row becomes a pickable option. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word.translation);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // The meaning shown is the user's own, replacing the dictionary's.
  const edited = isMeaningEdited(word);
  const { t, locale } = useI18n();
  const added = fmtDate(word.originallyTranslatedDate, locale, t("lists.never"));
  const reviewed = fmtDate(word.lastReviewedDate, locale, t("lists.never"));

  // Grow the edit field to its content — the whole point of the textarea is that a
  // long meaning is READABLE while editing. Height must be reset to auto first, or
  // scrollHeight only ever ratchets up as the text shrinks. Runs on open and on every
  // keystroke; jsdom reports scrollHeight 0, which the guard turns into a no-op.
  useEffect(() => {
    const fit = () => {
      const el = editRef.current;
      if (!el) return;
      el.style.height = "auto";
      if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // iOS WebKit can report the pre-layout scrollHeight on the open render (the
    // field had not yet taken its full-width line), which left a long meaning in a
    // one-line box. Measure again once layout has settled.
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [draft, editing]);

  // In select mode the row itself IS the control (no checkbox) — but it still carries
  // its own buttons (?, edit, tag, delete, and the edit field), so a click that lands
  // on any of those is theirs, not a selection toggle.
  const toggle = () => onToggleSelect?.();
  const rowClick = (e: MouseEvent) => {
    if (!selectable || !onToggleSelect) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .listrow__editing")) return;
    onToggleSelect();
  };

  // Selection is conveyed by role/aria (a listbox option), not a checkbox widget:
  // the picked state still reaches a screen reader, and the row stays keyboard-
  // operable now that there's no focusable box in it.
  const selectProps = selectable
    ? {
        role: "option",
        "aria-selected": selected,
        tabIndex: 0,
        onClick: rowClick,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.target !== e.currentTarget) return; // let the row's own buttons be
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); // Space would scroll the page
            toggle();
          }
        },
      }
    : {};

  return (
    <WordRow
      word={word}
      userId={word.userId}
      className={`${selectable ? "listrow--selectable" : ""}${
        selectable && selected ? " listrow--selected" : ""
      }`}
      {...selectProps}
      meta={
        <>
          {/* Word info as a floating OVERLAY (not inline text that reflows the row):
              Level (JLPT/CEFR) + Part of Speech, then the added/reviewed dates. The
              shared "?" affordance — same panel appears on the flashcard. */}
          <WordInfoButton
            word={word}
            extra={
              <>
                <span>
                  {t("lists.added")}: {added}
                </span>
                <span>
                  {t("lists.reviewed")}: {reviewed}
                </span>
              </>
            }
          />

          {/* The dots ARE the "Forgot" control — press them and a "Forgot?" overlay
              opens above (components/common/ConfidenceDots). Nothing about how they
              READ changes; the whole affordance is the press. */}
          <ConfidenceDots
            rating={word.confidenceRating}
            onForgot={onForgot && (async () => void (await onForgot()))}
          />

          {!editing && (
            <>
              <button
                // Purple once the meaning is the user's own — the row otherwise gives
                // no sign that what it shows is no longer the dictionary's.
                className={`iconbtn${edited ? " iconbtn--edited" : ""}`}
                onClick={() => {
                  setDraft(word.translation); // the row may have changed since (a revert)
                  setEditing(true);
                }}
                aria-label={t(edited ? "lists.editMeaningEditedTitle" : "lists.editMeaningTitle")}
                title={t(edited ? "lists.editMeaningEditedTitle" : "lists.editMeaningTitle")}
              >
                <PencilIcon size={16} />
              </button>

              {/* Tag into a list — the shared ＋ menu, so "New list…" (create on the
                  fly) works here just like the quiz recap. Shown even with no lists
                  yet, so the first one can be made. */}
              <TagListButton lists={lists} onPick={onTag} onCreate={onCreateList} />

              {/* One trash button. In a list it REMOVES FROM THIS LIST (word stays in
                  the vocabulary); delete-from-vocabulary is only offered in ALL, where
                  onRemoveFromList is absent. */}
              {onRemoveFromList ? (
                <button
                  className="iconbtn"
                  onClick={onRemoveFromList}
                  aria-label={t("lists.removeFromList")}
                  title={t("lists.removeFromList")}
                >
                  <TrashIcon size={16} />
                </button>
              ) : (
                <button
                  className="iconbtn iconbtn--danger"
                  onClick={onDelete}
                  aria-label={t("lists.deleteFromVocab")}
                  title={t("lists.deleteFromVocab")}
                >
                  <TrashIcon size={16} />
                </button>
              )}
            </>
          )}
        </>
      }
      meaning={
        editing ? (
          <span className="listrow__editing">
            {/* A TEXTAREA, not a single-line input: a multi-sense meaning ("nightclub;
                club (weapon); playing-card suit") ran off the end of the field with
                the row's full width sitting unused, so the text being edited couldn't
                be read. It grows to fit its content (see the effect above) instead of
                scrolling sideways. Enter inserts a newline and never saves — a
                Japanese IME uses Enter to confirm kanji, so saving on it would commit
                mid-conversion (same rule as the translate box); ✓ commits. */}
            <span className="listrow__editbox">
              <textarea
                ref={editRef}
                className="input input--sm listrow__editfield"
                rows={2}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={t("lists.editMeaningAria")}
              />
              {/* Under the field's bottom-right corner, and only when there is an
                  original to go back to (an edited dictionary word). */}
              {edited && onRevert && (
                <button
                  type="button"
                  className="listrow__revert"
                  onClick={() => {
                    onRevert();
                    setEditing(false);
                  }}
                >
                  {t("lists.revertMeaning")}
                </button>
              )}
            </span>
            <button
              className="iconbtn"
              onClick={() => {
                // Collapse the newlines the textarea now allows: a meaning renders as
                // one line per SENSE (split on ";"), so a stored line break would show
                // up as a stray space anyway. Nothing about the stored shape changes.
                const v = draft.replace(/\s+/g, " ").trim();
                if (v) onEdit(v);
                setEditing(false);
              }}
              title={t("common.save")}
            >
              ✓
            </button>
            <button
              className="iconbtn"
              onClick={() => {
                setDraft(word.translation);
                setEditing(false);
              }}
              title={t("common.cancel")}
            >
              ✕
            </button>
          </span>
        ) : undefined
      }
    />
  );
}
