// Shared sort control: an axis dropdown + a direction switch (least ⇄ most). Used by
// BOTH the Lists surface and the article summary so the two read identically. Purely
// presentational — the caller supplies the axes (with resolved least/most labels) and
// owns the axis/dir state. A non-directional axis (e.g. "Recommended") disables the
// switch while it's selected and shows a single label.
import { SwapVertIcon } from "./icons";
import "./sortcontrols.css";

export type SortDir = "least" | "most";

export interface SortOption {
  value: string;
  /** false = no direction (single label, switch inert while selected). Default true. */
  directional?: boolean;
  /** Label shown in the "least" direction (or the sole label when non-directional). */
  least: string;
  /** Label shown in the "most" direction. */
  most: string;
}

export function SortControls({
  label,
  flipLabel,
  options,
  value,
  dir,
  onValue,
  onDir,
}: {
  /** Visible "Sort" label. */
  label: string;
  /** aria/title for the direction switch. */
  flipLabel: string;
  options: SortOption[];
  value: string;
  dir: SortDir;
  onValue: (v: string) => void;
  onDir: (d: SortDir) => void;
}) {
  const current = options.find((o) => o.value === value);
  const nonDirectional = current?.directional === false;

  return (
    <div className="sortctl">
      <label className="sortctl__pick">
        {label}
        <select
          className="select select--sm"
          value={value}
          onChange={(e) => onValue(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.directional === false || dir === "least" ? o.least : o.most}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="iconbtn sortctl__flip"
        onClick={() => onDir(dir === "least" ? "most" : "least")}
        disabled={nonDirectional}
        aria-label={flipLabel}
        title={flipLabel}
      >
        <SwapVertIcon size={16} />
      </button>
    </div>
  );
}
