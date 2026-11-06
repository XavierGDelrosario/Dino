// Source → target language selectors with a swap (⇄) button between them.
// Shared by the word and paragraph translate panels.
//
// Source may be the AUTO_DETECT sentinel; target is always a concrete language.
//
// While only two languages exist (FIXED_LANGUAGE_PAIR) the two sides are plain
// labels — a dropdown would offer nothing the ⇄ doesn't. A third language in the
// registry turns the dropdowns back on with no change here.
// The flip itself is `swapLanguages` (services/language) — shared with the Lists
// add-word form so both surfaces flip identically.
import {
  FIXED_LANGUAGE_PAIR,
  AUTO_DETECT,
  languageName,
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

  if (FIXED_LANGUAGE_PAIR) {
    const sourceName =
      source === AUTO_DETECT ? sourceOptions()[0].name : languageName(source);
    return (
      <div className="langbar">
        <span className="ellipsis langbar__lang" aria-label={t("langbar.sourceAria")}>{sourceName}</span>
        <SwapButton onClick={swap} />
        <span className="ellipsis langbar__lang" aria-label={t("langbar.targetAria")}>{languageName(target)}</span>
      </div>
    );
  }

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

      <SwapButton onClick={swap} />

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

/** The ⇄ between the two sides (also used by the Lists add-word form's LangPair). */
export function SwapButton({ onClick, small = false }: { onClick: () => void; small?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`langbar__swap${small ? " langbar__swap--sm" : ""}`}
      onClick={onClick}
      title={t("langbar.swapTitle")}
      aria-label={t("langbar.swapAria")}
    >
      ⇄
    </button>
  );
}
