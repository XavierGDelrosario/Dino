// Source → target language selectors with a swap (⇄) button between them.
// Shared by the word and paragraph translate panels.
//
// Source may be the AUTO_DETECT sentinel; target is always a concrete language.
// The flip itself is `swapLanguages` (services/language) — shared with the Lists
// add-word form so both surfaces flip identically.
import {
  sourceOptions,
  targetOptions,
  swapLanguages,
  type LangCode,
  type SourceSelection,
} from "../../services/language";
import { useI18n } from "../../i18n";
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
  const { t } = useI18n();
  const swap = () => {
    if (onSwap) {
      onSwap();
      return;
    }
    const flipped = swapLanguages(source, target);
    onSource(flipped.source);
    onTarget(flipped.target);
  };

  return (
    <div className="langbar">
      <select
        className="select"
        value={source}
        onChange={(e) => onSource(e.target.value)}
        aria-label={t("langbar.sourceAria")}
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
        title={t("langbar.swapTitle")}
        aria-label={t("langbar.swapAria")}
      >
        ⇄
      </button>

      <select
        className="select"
        value={target}
        onChange={(e) => onTarget(e.target.value as LangCode)}
        aria-label={t("langbar.targetAria")}
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
