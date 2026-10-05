// =========================================================
// "Report an issue" — the dialog behind every flag button.
//
// ONE component for both surfaces (the reader's word popover, the flashcard) because
// the report is the same act in both places; only the target differs, and that arrives
// as props. A second copy would drift the moment one of them gained a field.
//
// The text box is REQUIRED: Send stays disabled until something is written (user,
// 2026-10-06). It used to be optional, on the theory that the flagged word is the whole
// signal — but a one-tap report is also a one-tap accident, and a queue of bare flags
// with nothing to act on is spam whoever sent it.
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
import { LoadingDots } from "./Loading";

const CLOSE_AFTER_MS = 900;

export function ReportIssueDialog({
  input,
  wordId,
  output,
  onClose,
}: {
  /** The word being reported — shown back to the user so they can see what they're
   *  filing against, and sent as the report's `input`. */
  input: string;
  /** The exact sense, when the surface knows it. */
  wordId?: string | null;
  /** The translation being reported, when the target is a translation and not a word
   *  — shown under the input, and sent with it. */
  output?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the box on open (a note is required, so the user shouldn't have to aim
  // first), and let Escape back out — this is a transient aside.
  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    if (busy || sent || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await reportQualityIssue({ input, description: text, wordId, output });
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
        {/* ✕ rather than a Cancel button: backing out is not a decision worth a
            labelled control next to Send, and the corner is where a dismiss is looked
            for. Escape and a backdrop click still work. */}
        <button
          type="button"
          className="iconbtn reportdlg__close"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          ✕
        </button>
        <h3 className="reportdlg__title">{t("report.title")}</h3>
        <p className="reportdlg__target ellipsis" title={input}>{input}</p>
        {output && (
          <p className="reportdlg__output ellipsis" title={output}>{output}</p>
        )}

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
            {/* One action, centred — with Cancel gone there is nothing to balance it
                against, and a lone right-aligned button reads as unfinished.
                Disabled until there is a note (see the header). */}
            <div className="reportdlg__actions">
              <button type="button" className="btn" onClick={() => void send()} disabled={busy || !text.trim()}>
                {busy ? <LoadingDots /> : t("report.send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
