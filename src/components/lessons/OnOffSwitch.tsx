// A labelled on/off slider ("Reader ◯—"). Same visual family as LangSwitch: a pill
// track with a sliding thumb, accent-filled when on.
export function OnOffSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`onoff${checked ? " onoff--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="onoff__label">{label}</span>
      <span className="onoff__track" aria-hidden="true">
        <span className="onoff__thumb" />
      </span>
    </button>
  );
}
