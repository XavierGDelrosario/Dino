// One word in a list: headword (+reading) · meaning · confidence · row actions.
// Editing the meaning is inline (setting custom_translation = an override on the
// SAME user_words row, never a new one). "Add to list" tags it into a sub-list;
// "Remove from list" only shows when viewing a sub-list (un-tags, keeps the word
// in the vocabulary); the trash deletes it from the vocabulary entirely.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { UserWord } from "../../services/words/userWords";
import type { List } from "../../services/lists";
import { ListMenu } from "../common/ListMenu";
import { PencilIcon, TrashIcon } from "../common/icons";
import { WordInfoButton } from "../common/WordInfo";
import { SpeakButton } from "../common/SpeakButton";
import { SenseExample } from "../common/SenseExample";
import { pronounceableText } from "../../services/voice";
import { useI18n, type Locale } from "../../i18n";
import "./lists.css";

function ConfidenceDots({ rating }: { rating: number }) {
  const { t } = useI18n();
  return (
    <span className="dots" aria-label={t("lists.confidenceOf", { n: rating })}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`dot${i < rating ? " dot--on" : ""}`} />
      ))}
    </span>
  );
}

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
  onDelete,
  onTag,
  onCreateList,
  onRemoveFromList,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  word: UserWord;
  lists: List[];
  onEdit: (translation: string) => void;
  onDelete: () => void;
  onTag: (listId: string) => void;
  /** Create a sub-list and tag this word into it (the on-the-fly "New list…").
   *  Only completion is used (the menu closes); the resolved value is ignored. */
  onCreateList: (name: string) => Promise<unknown>;
  /** Present only when viewing a sub-list (enables un-tagging). */
  onRemoveFromList?: () => void;
  /** Select mode (the Lists "Select" toggle): the row becomes a pickable option. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(word.translation);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { t, locale } = useI18n();
  const added = fmtDate(word.originallyTranslatedDate, locale, t("lists.never"));
  const reviewed = fmtDate(word.lastReviewedDate, locale, t("lists.never"));

  // Grow the edit field to its content — the whole point of the textarea is that a
  // long meaning is READABLE while editing. Height must be reset to auto first, or
  // scrollHeight only ever ratchets up as the text shrinks. Runs on open and on every
  // keystroke; jsdom reports scrollHeight 0, which the guard turns into a no-op.
  useEffect(() => {
    const el = editRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  // Split a multi-sense translation ("cat; feline; puss") so each meaning gets its
  // own line below the header instead of one squished run.
  const meanings = word.translation
    .split(";")
    .map((m) => m.trim())
    .filter(Boolean);

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
    <li
      className={`listrow${selectable ? " listrow--selectable" : ""}${
        selectable && selected ? " listrow--selected" : ""
      }`}
      {...selectProps}
    >
      {/* Header: the word (+reading) and ALL the metadata/actions, so the meaning
          below gets the full row width. */}
      <div className="listrow__header">
        <span className="listrow__head">
          {word.input}
          {word.inputReading && <em className="listrow__reading">{word.inputReading}</em>}
        </span>

        <div className="listrow__meta">
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

          <ConfidenceDots rating={word.confidenceRating} />

          {!editing && (
            <>
              <button
                className="iconbtn"
                onClick={() => setEditing(true)}
                aria-label={t("lists.editMeaningTitle")}
                title={t("lists.editMeaningTitle")}
              >
                <PencilIcon size={16} />
              </button>

              {/* Tag into a sub-list — the shared ListMenu, so "New list…" (create
                  on the fly) works here just like the translate/quiz add button.
                  Shown even with no sub-lists yet, so the first one can be made. */}
              <button
                ref={tagBtnRef}
                className="iconbtn listrow__tag"
                onClick={() => setTagMenu(true)}
                aria-label={t("lists.addToList")}
                title={t("lists.addToList")}
              >
                ＋
              </button>
              {tagMenu && (
                <ListMenu
                  anchorRef={tagBtnRef}
                  lists={lists}
                  title={t("lists.addToList")}
                  onPick={(listId) => {
                    onTag(listId);
                    setTagMenu(false);
                  }}
                  onCreate={(name) => onCreateList(name).then(() => setTagMenu(false))}
                  onClose={() => setTagMenu(false)}
                />
              )}

              {/* One trash button. In a sub-list it REMOVES FROM THIS LIST (word
                  stays in the vocabulary); delete-from-vocabulary is only offered
                  in ALL, where onRemoveFromList is absent. */}
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
        </div>
      </div>

      {/* Bottom row: the meaning(s) on the left, the speak button pinned bottom-RIGHT
          — the row's one audio affordance, kept away from the cluster of edit/tag/
          delete actions in the header so it reads as "play this", not another action.
          It wraps BOTH branches, so it stays put while the meaning is being edited. */}
      <div className="listrow__foot">
        {editing ? (
          <span className="listrow__editing">
            {/* A TEXTAREA, not a single-line input: a multi-sense meaning ("nightclub;
                club (weapon); playing-card suit") ran off the end of the field with
                the row's full width sitting unused, so the text being edited couldn't
                be read. It grows to fit its content (see the effect above) instead of
                scrolling sideways. Enter inserts a newline and never saves — a
                Japanese IME uses Enter to confirm kanji, so saving on it would commit
                mid-conversion (same rule as the translate box); ✓ commits. */}
            <textarea
              ref={editRef}
              className="input input--sm listrow__editfield"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("lists.editMeaningAria")}
            />
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
        ) : (
          <div className="listrow__meaning">
            {meanings.map((m, i) => (
              <span key={i} className="listrow__meaning-line">
                {m}
                {i === 0 && word.translationReading && (
                  <em className="listrow__reading">{word.translationReading}</em>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Example sentence for the saved SENSE, immediately left of the listen button:
            both answer "tell me more about this word" rather than changing anything, so
            they sit together and away from the header's edit/tag/delete cluster. Renders
            nothing until the sense has been written up. */}
        <SenseExample
          example={word.example}
          exampleGloss={word.exampleGloss}
          definitionSource={word.definitionSource}
          userId={word.userId}
          sourceLang={word.sourceLang}
          targetLang={word.targetLang}
        />

        {/* Read the WORD aloud — never the meaning (an English gloss spoken by a
            Japanese voice is noise). Speaks the sense's reading where the headword is
            kanji, so a homograph gets the meaning's own pronunciation. The language is
            the row's own, so an English word in the EN-learner direction is spoken by
            an English voice. */}
        <SpeakButton text={pronounceableText(word)} lang={word.sourceLang} size={16} />
      </div>
    </li>
  );
}
