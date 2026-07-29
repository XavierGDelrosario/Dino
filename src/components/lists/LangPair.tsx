// The source → target language dual-select of the Lists add-word form — the
// compact sibling of the Translate surface's <LangBar>, with the same ⇄ flip
// button between the two selects (the flip itself is the shared, pure
// `swapLanguages`, so the two surfaces can't drift).
import { useI18n } from "../../i18n";
import "./lists.css";

type LangOption = { code: string; name: string };

export function LangPair({
  source,
  onSource,
  target,
  onTarget,
  onSwap,
  sourceOptions,
  targetOptions,
  sourceAria,
  targetAria,
}: {
  source: string;
  onSource: (code: string) => void;
  target: string;
  onTarget: (code: string) => void;
  /** Flip input ⇄ output. */
  onSwap: () => void;
  sourceOptions: LangOption[];
  targetOptions: LangOption[];
  sourceAria?: string;
  targetAria?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="addword__langs">
      <select
        className="select select--sm"
        value={source}
        onChange={(e) => onSource(e.target.value)}
        aria-label={sourceAria}
      >
        {sourceOptions.map((o) => (
          <option key={o.code} value={o.code}>{o.name}</option>
        ))}
      </select>
      <button
        type="button"
        className="langbar__swap langbar__swap--sm"
        onClick={onSwap}
        title={t("langbar.swapTitle")}
        aria-label={t("langbar.swapAria")}
      >
        ⇄
      </button>
      <select
        className="select select--sm"
        value={target}
        onChange={(e) => onTarget(e.target.value)}
        aria-label={targetAria}
      >
        {targetOptions.map((o) => (
          <option key={o.code} value={o.code}>{o.name}</option>
        ))}
      </select>
    </div>
  );
}
