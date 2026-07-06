// One word in a list: headword (+reading) · meaning · confidence · row actions.
// Editing the meaning is inline (setting custom_translation = an override on the
// SAME user_words row, never a new one). "Add to list" tags it into a sub-list;
// "Remove from list" only shows when viewing a sub-list (un-tags, keeps the word
// in the vocabulary); the trash deletes it from the vocabulary entirely.
import { useRef, useState } from "react";
import type { UserWord } from "../../services/words/userWords";
import type { List } from "../../services/lists";
import { ListMenu } from "../common/ListMenu";
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
}: {
  word: UserWord;
  lists: List[];
  onEdit: (translation: string) => void;
  onDelete: () => void;
  onTag: (listId: string) => void;
  /** Create a sub-list and tag this word into it (the on-the-fly "New list…"). */
  onCreateList: (name: string) => Promise<void>;
  /** Present only when viewing a sub-list (enables un-tagging). */
  onRemoveFromList?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(word.translation);
  // The date info is a TAP-to-toggle panel, not a native `title` tooltip: native
  // tooltips don't fire on touch (this app targets iOS) and are delayed/unstyled
  // on desktop, so the "?" appeared to do nothing. Toggling a visible panel works
  // on every platform.
  const [showInfo, setShowInfo] = useState(false);
  const { t, locale } = useI18n();
  const added = fmtDate(word.originallyTranslatedDate, locale, t("lists.never"));
  const reviewed = fmtDate(word.lastReviewedDate, locale, t("lists.never"));

  // Split a multi-sense translation ("cat; feline; puss") so each meaning gets its
  // own line below the header instead of one squished run.
  const meanings = word.translation
    .split(";")
    .map((m) => m.trim())
    .filter(Boolean);

  return (
    <li className="listrow">
      {/* Header: the word (+reading) and ALL the metadata/actions, so the meaning
          below gets the full row width. */}
      <div className="listrow__header">
        <span className="listrow__head">
          {word.input}
          {word.inputReading && <em className="listrow__reading">{word.inputReading}</em>}
        </span>

        <div className="listrow__meta">
          {/* Date info as a floating OVERLAY (not inline text that reflows the row).
              Hover reveals it on desktop (pure CSS); tap toggles it on touch (iOS)
              via aria-expanded — kept separate so iOS's synthetic mouse events on a
              tap don't fight the toggle. The panel is always rendered; CSS shows it. */}
          <span className="listrow__info-wrap">
            <button
              type="button"
              className="listrow__info"
              aria-label={t("lists.infoAria", { added, reviewed })}
              aria-expanded={showInfo}
              onClick={() => setShowInfo((v) => !v)}
            >
              ?
            </button>
            <div className="listrow__infopanel" role="note">
              <span>
                {t("lists.added")}: {added}
              </span>
              <span>
                {t("lists.reviewed")}: {reviewed}
              </span>
            </div>
          </span>

          <ConfidenceDots rating={word.confidenceRating} />

          {!editing && (
            <>
              <button className="iconbtn" onClick={() => setEditing(true)} title={t("lists.editMeaningTitle")}>
                ✎
              </button>

              {/* Tag into a sub-list — the shared ListMenu, so "New list…" (create
                  on the fly) works here just like the translate/quiz add button.
                  Shown even with no sub-lists yet, so the first one can be made. */}
              <button
                ref={tagBtnRef}
                className="iconbtn listrow__tag"
                onClick={() => setTagMenu(true)}
                aria-label={t("lists.addToSublist")}
                title={t("lists.addToSublist")}
              >
                ＋
              </button>
              {tagMenu && (
                <ListMenu
                  anchorRef={tagBtnRef}
                  lists={lists}
                  title={t("lists.addToSublist")}
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
                  title={t("lists.removeFromList")}
                >
                  🗑
                </button>
              ) : (
                <button
                  className="iconbtn iconbtn--danger"
                  onClick={onDelete}
                  title={t("lists.deleteFromVocab")}
                >
                  🗑
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Meaning(s) on their own line(s) below the header. */}
      {editing ? (
        <span className="listrow__editing">
          <input
            className="input input--sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t("lists.editMeaningAria")}
          />
          <button
            className="iconbtn"
            onClick={() => {
              const v = draft.trim();
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
    </li>
  );
}
