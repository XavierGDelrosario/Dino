// Copy-to-clipboard: the standard two-sheets icon, which becomes a tick for a moment
// once the text is on the clipboard — the only feedback a copy needs.
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { copyText } from "../../lib/clipboard";
import { useI18n } from "../../i18n";

/** How long the tick stays before the icon goes back to "copy". */
const COPIED_MS = 1500;

export function CopyButton({
  text,
  className = "iconbtn",
  size,
}: {
  /** Exactly what goes on the clipboard. Renders nothing when it is empty. */
  text: string;
  className?: string;
  size?: number;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!text.trim()) return null;
  const label = t(copied ? "common.copied" : "common.copy");
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        if (!(await copyText(text))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
    </button>
  );
}
