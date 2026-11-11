// A two-position sliding switch with a language code on each side ("EN | JA"); the
// thumb sits under the active one. Used by the lesson page to pick the language the
// explanations are shown in. Generic over the pair — the caller passes both codes.
import type { LangCode } from "../../services/language";

export function LangSwitch({
  left,
  right,
  value,
  onChange,
  label,
}: {
  left: LangCode;
  right: LangCode;
  value: LangCode;
  onChange: (next: LangCode) => void;
  /** Accessible name ("Explanation language"). */
  label: string;
}) {
  const onRight = value === right;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={onRight}
      aria-label={label}
      title={label}
      className={`langswitch${onRight ? " langswitch--right" : ""}`}
      onClick={() => onChange(onRight ? left : right)}
    >
      <span className="langswitch__thumb" aria-hidden="true" />
      <span className={`langswitch__opt${onRight ? "" : " is-on"}`}>{left}</span>
      <span className={`langswitch__opt${onRight ? " is-on" : ""}`}>{right}</span>
    </button>
  );
}
