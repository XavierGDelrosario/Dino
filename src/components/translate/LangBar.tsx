// Source → target language selectors with a swap (⇄) button between them.
// Shared by the word and paragraph translate panels.
//
// Source may be the AUTO_DETECT sentinel; target is always a concrete language.
// On swap the (concrete) target becomes the new source; the new target is the
// old source if it was concrete, else the other supported language (so we never
// land on source === target, and never put "Detect" in the target slot).
import {
  sourceOptions,
  targetOptions,
  AUTO_DETECT,
  SUPPORTED_LANGUAGES,
  type LangCode,
  type SourceSelection,
} from "../../services/language";
import "./translate.css";

export function LangBar({
  source,
  target,
  onSource,
  onTarget,
  onSwap,
}: {
  source: SourceSelection;
  target: LangCode;
  onSource: (code: SourceSelection) => void;
  onTarget: (code: LangCode) => void;
  /** Full swap (languages + text + re-translate). When omitted, the button only
   *  swaps the language selectors. */
  onSwap?: () => void;
}) {
  const swap = () => {
    if (onSwap) {
      onSwap();
      return;
    }
    const newSource: SourceSelection = target;
    const newTarget: LangCode =
      source !== AUTO_DETECT
        ? source
        : SUPPORTED_LANGUAGES.find((l) => l.code !== target)?.code ?? target;
    onSource(newSource);
    onTarget(newTarget);
  };

  return (
    <div className="langbar">
      <select
        className="select"
        value={source}
        onChange={(e) => onSource(e.target.value)}
        aria-label="Source language"
      >
        {sourceOptions().map((o) => (
          <option key={o.code} value={o.code}>
            {o.name}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="langbar__swap"
        onClick={swap}
        title="Swap languages"
        aria-label="Swap source and target languages"
      >
        ⇄
      </button>

      <select
        className="select"
        value={target}
        onChange={(e) => onTarget(e.target.value as LangCode)}
        aria-label="Target language"
      >
        {targetOptions().map((o) => (
          <option key={o.code} value={o.code}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}
