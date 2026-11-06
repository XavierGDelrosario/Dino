// The source → target language dual-select of the Lists add-word form — the
// compact sibling of the Translate surface's <LangBar>, with the same ⇄ flip
// button between the two selects (the flip itself is the shared, pure
// `swapLanguages`, so the two surfaces can't drift). Like LangBar, the sides are
// plain labels while only two languages exist (FIXED_LANGUAGE_PAIR).
import { SwapButton } from "../translate/LangBar";
import { FIXED_LANGUAGE_PAIR } from "../../services/language";
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
  const nameOf = (code: string, options: LangOption[]) =>
    options.find((o) => o.code === code)?.name ?? code;
  if (FIXED_LANGUAGE_PAIR) {
    return (
      <div className="addword__langs">
        <span className="ellipsis langbar__lang langbar__lang--sm" aria-label={sourceAria}>{nameOf(source, sourceOptions)}</span>
        <SwapButton onClick={onSwap} small />
        <span className="ellipsis langbar__lang langbar__lang--sm" aria-label={targetAria}>{nameOf(target, targetOptions)}</span>
      </div>
    );
  }
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
      <SwapButton onClick={onSwap} small />
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
