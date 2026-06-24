// One word in a list: headword (+reading) · meaning · confidence · row actions.
// Editing the meaning is inline (setting custom_translation = an override on the
// SAME user_words row, never a new one). "Add to list" tags it into a sub-list;
// "Remove from list" only shows when viewing a sub-list (un-tags, keeps the word
// in the vocabulary); the trash deletes it from the vocabulary entirely.
import { useState } from "react";
import type { UserWord } from "../../services/words/userWords";
import type { List } from "../../services/lists";
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
  onRemoveFromList,
}: {
  word: UserWord;
  lists: List[];
  onEdit: (translation: string) => void;
  onDelete: () => void;
  onTag: (listId: string) => void;
  /** Present only when viewing a sub-list (enables un-tagging). */
  onRemoveFromList?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word.translation);
  const { t, locale } = useI18n();
  const added = fmtDate(word.originallyTranslatedDate, locale, t("lists.never"));
  const reviewed = fmtDate(word.lastReviewedDate, locale, t("lists.never"));

  return (
    <li className="listrow">
      <div className="listrow__main">
        <span className="listrow__head">
          {word.input}
          {word.inputReading && <em className="listrow__reading">{word.inputReading}</em>}
        </span>

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
          <span className="listrow__meaning">
            {word.translation}
            {word.translationReading && (
              <em className="listrow__reading">{word.translationReading}</em>
            )}
          </span>
        )}
      </div>

      <div className="listrow__meta">
        <span
          className="listrow__info"
          role="img"
          aria-label={t("lists.infoAria", { added, reviewed })}
          title={t("lists.infoTitle", { added, reviewed })}
        >
          ?
        </span>

        <ConfidenceDots rating={word.confidenceRating} />

        {!editing && (
          <>
            <button className="iconbtn" onClick={() => setEditing(true)} title={t("lists.editMeaningTitle")}>
              ✎
            </button>

            {lists.length > 0 && (
              <select
                className="iconbtn listrow__tag"
                value=""
                onChange={(e) => {
                  if (e.target.value) onTag(e.target.value);
                  e.target.value = "";
                }}
                aria-label={t("lists.addToSublist")}
                title={t("lists.addToSublist")}
              >
                <option value="">{t("lists.addListOption")}</option>
                {lists.map((l) => (
                  <option key={l.listId} value={l.listId}>
                    {l.listName}
                  </option>
                ))}
              </select>
            )}

            {onRemoveFromList && (
              <button
                className="iconbtn"
                onClick={onRemoveFromList}
                title={t("lists.removeFromList")}
              >
                −
              </button>
            )}

            <button
              className="iconbtn iconbtn--danger"
              onClick={onDelete}
              title={t("lists.deleteFromVocab")}
            >
              🗑
            </button>
          </>
        )}
      </div>
    </li>
  );
}
