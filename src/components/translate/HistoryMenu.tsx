// The session-history dropdown: a clock button that opens the list of what you
// translated this session (see services/translateHistory.ts — session only).
//
// It's a POPUP rather than an inline row because the history is a look-back, not
// part of the translate flow: a chip row sat permanently between the input and the
// study section, pushing the actual work down the page to show text the user had
// just typed. Behind a button it costs nothing until asked for.
//
// Closes on outside click and Escape, and returns focus to the trigger — a menu
// you can open with the keyboard but not dismiss is a trap.
import { useEffect, useRef } from "react";
import { HistoryIcon } from "../common/icons";
import { useI18n } from "../../i18n";
import type { TranslateHistoryEntry } from "../../services/translateHistory";

export function HistoryMenu({
  entries,
  open,
  onToggle,
  onClose,
  onPick,
  onClear,
  disabled = false,
}: {
  entries: readonly TranslateHistoryEntry[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (entry: TranslateHistoryEntry) => void;
  onClear: () => void;
  /** A translation is in flight — replaying now would race it. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      btnRef.current?.focus(); // don't strand focus inside a panel that's gone
    };
    // `mousedown`, not `click`: a click that starts inside the panel and ends
    // outside it (a drag while selecting an entry's text) shouldn't dismiss.
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="thistory" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="thistory__btn"
        aria-label={t("translate.history")}
        title={t("translate.history")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <HistoryIcon />
      </button>

      {open && (
        <div className="thistory__panel" role="menu">
          <div className="thistory__head">
            <span className="thistory__title">{t("translate.history")}</span>
            <button
              type="button"
              className="thistory__clear"
              aria-label={t("translate.historyClearAria")}
              onClick={() => {
                onClear();
                onClose();
              }}
            >
              {t("translate.historyClear")}
            </button>
          </div>
          <ul className="thistory__list">
            {entries.map((entry) => (
              <li key={`${entry.source}|${entry.target}|${entry.text}`}>
                <button
                  type="button"
                  role="menuitem"
                  className="thistory__item"
                  // Full text as the accessible name: the row clamps to two lines,
                  // so the visible label can be a truncated prefix.
                  title={t("translate.historyReplay", { text: entry.text })}
                  aria-label={t("translate.historyReplay", { text: entry.text })}
                  disabled={disabled}
                  onClick={() => {
                    onPick(entry);
                    onClose();
                  }}
                >
                  <span className="thistory__text">{entry.text}</span>
                  <span className="thistory__dir" aria-hidden="true">
                    {entry.source} → {entry.target}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
