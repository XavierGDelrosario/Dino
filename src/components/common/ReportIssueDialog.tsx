// =========================================================
// "Report an issue" — the dialog behind every flag button.
//
// ONE component for both surfaces (the reader's word popover, the flashcard) because
// the report is the same act in both places; only the target differs, and that arrives
// as props. A second copy would drift the moment one of them gained a field.
//
// The text box is OPTIONAL and says so. The valuable signal is "this word is wrong",
// which the surface already knows — demanding a sentence before recording it would
// lose most of the reports. Send is therefore enabled with the box empty.
//
// It confirms and closes itself rather than leaving the user to dismiss a success
// state: filing a report is an aside from reading or quizzing, and the flow should
// hand the screen straight back.
// =========================================================
import { useEffect, useRef, useState } from "react";
import { reportQualityIssue, REPORT_MAX_CHARS } from "../../services/quality";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../i18n";
import { ErrorText } from "./ErrorText";
import "./report.css";

const CLOSE_AFTER_MS = 900;

export function ReportIssueDialog({
  input,
  wordId,
  onClose,
}: {
  /** The word being reported — shown back to the user so they can see what they're
   *  filing against, and sent as the report's `input`. */
  input: string;
  /** The exact sense, when the surface knows it. */
  wordId?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the box on open (typing is optional, but a user who wants to type shouldn't
  // have to aim first), and let Escape back out — this is a transient aside.
  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    if (busy || sent) return;
    setBusy(true);
    setError(null);
    try {
      await reportQualityIssue({ input, description: text, wordId });
      setSent(true);
      setTimeout(onClose, CLOSE_AFTER_MS);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false); // stay open so the text isn't lost and Send can be retried
    }
  };

  return (
    // The backdrop closes on click; the panel stops propagation so a click inside it
    // (including a drag that ends outside the textarea) never dismisses the dialog.
    <div className="reportdlg" role="presentation" onClick={onClose}>
      <div
        className="reportdlg__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("report.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="reportdlg__title">{t("report.title")}</h3>
        <p className="reportdlg__target" title={input}>{input}</p>

        {sent ? (
          <p className="reportdlg__sent">{t("report.sent")}</p>
        ) : (
          <>
            <textarea
              ref={boxRef}
              className="textarea reportdlg__box"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, REPORT_MAX_CHARS))}
              placeholder={t("report.placeholder")}
              aria-label={t("report.placeholder")}
              rows={4}
            />
            <ErrorText message={error} />
            <div className="reportdlg__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
                {t("common.cancel")}
              </button>
              {/* Enabled with an empty box on purpose — see the header. */}
              <button type="button" className="btn btn--sm" onClick={() => void send()} disabled={busy}>
                {busy ? "…" : t("report.send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
