// The flag affordance + the dialog it opens, as one unit — so a surface adds reporting
// with a single element and can't ship the button without the dialog behind it.
//
// Click is stopped from propagating for the same reason SpeakButton does it: this sits
// inside a flashcard (a click flips it) and inside the reader's word popover (a click
// picks a sense). Reporting must never also do one of those.
import { useState } from "react";
import { FlagIcon } from "./icons";
import { ReportIssueDialog } from "./ReportIssueDialog";
import { useI18n } from "../../i18n";
import "./report.css";

export function ReportFlagButton({
  input,
  wordId,
  className = "iconbtn",
  size,
}: {
  /** The word being reported. Rendering is skipped when there's nothing to report. */
  input: string;
  wordId?: string | null;
  className?: string;
  size?: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!input.trim()) return null;

  return (
    <>
      <button
        type="button"
        className={`${className} reportbtn`}
        aria-label={t("report.flag")}
        title={t("report.flag")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <FlagIcon size={size} />
      </button>
      {open && (
        <ReportIssueDialog input={input} wordId={wordId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
