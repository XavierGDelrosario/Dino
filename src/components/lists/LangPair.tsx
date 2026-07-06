// The source → target language dual-select shared by the add-word forms
// (<AddWord> dictionary lookup, <AddCustomWord> own word). Same markup verbatim;
// only the option lists and aria labels differ.
import "./lists.css";

type LangOption = { code: string; name: string };

export function LangPair({
  source,
  onSource,
  target,
  onTarget,
  sourceOptions,
  targetOptions,
  sourceAria,
  targetAria,
}: {
  source: string;
  onSource: (code: string) => void;
  target: string;
  onTarget: (code: string) => void;
  sourceOptions: LangOption[];
  targetOptions: LangOption[];
  sourceAria?: string;
  targetAria?: string;
}) {
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
      <span className="langbar__arrow">→</span>
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
