// The Lists filter surface, in two pieces so the VIEW decides where each goes:
// <FilterButton> (the funnel + its active-count badge) sits in the actions row, and
// <FilterPanel> renders BELOW that whole row, in the page flow. Deliberately NOT a
// floating/hover card — it is a big, six-axis form the user works in, so it pushes
// the rows down like the add-word form rather than hovering over them (a panel that
// vanishes on an outside click is hostile to that kind of editing, and hover doesn't
// exist on iOS at all). The open/closed state therefore lives in the view.
//
// The filter MODEL is pure domain logic and lives in services/words/filters.ts; this
// file is only the surface.
//
// Language is a set of toggle buttons rather than a select because it drives a
// second axis: checking a language reveals its proficiency framework's bands
// (JLPT for JA, CEFR for EN) with every band already checked — unchecking the
// language hides them again. The bands can't be a flat list because the scale
// itself is per-language.
import { useEffect } from "react";
import { FilterIcon } from "../common/icons";
import { COMMONNESS_LABEL_KEY, POS_LABEL_KEY } from "../common/wordLabels";
import { proficiencyFrameworkFor } from "../../services/proficiency";
import { targetOptions, type LangCode, type PosCategory } from "../../services/language";
import type { LevelValue } from "../../services/difficulty";
import { useI18n } from "../../i18n";
import { PeriodSelect } from "./PeriodSelect";
import {
  activeFilterCount,
  confBounds,
  toggle,
  toggleLang,
  CONF_MIN,
  CONF_MAX,
  NO_FILTERS,
  type WordFilters,
} from "../../services/words/filters";

const USAGE_BANDS: LevelValue[] = [1, 2, 3, 4, 5];

const langName = (code: string) =>
  targetOptions().find((o) => o.code === code)?.name ?? code;

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="filtermenu__check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

/** The funnel toggle for the actions row. Badges how many axes are narrowing. */
export function FilterButton({
  filters,
  open,
  onToggle,
}: {
  filters: WordFilters;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const active = activeFilterCount(filters);
  return (
    <button
      type="button"
      className={`btn lists__addtoggle filtermenu__btn${active > 0 ? " filtermenu__btn--on" : ""}`}
      aria-expanded={open}
      // Fuller than the visible "Filter", but CONTAINS it (label-in-name), so voice
      // control still matches what a user reads on screen.
      aria-label={t("lists.filterAria")}
      title={t("lists.filterAria")}
      onClick={onToggle}
    >
      <FilterIcon size={16} />
      {t("lists.filterTitle")}
      {active > 0 && <span className="filtermenu__badge">{active}</span>}
    </button>
  );
}

/** The panel itself — rendered by the view BELOW the actions row (never floating). */
export function FilterPanel({
  filters,
  onChange,
  onClose,
  langsPresent,
  posPresent,
}: {
  filters: WordFilters;
  onChange: (next: WordFilters) => void;
  onClose: () => void;
  /** Input languages actually present in the current list. */
  langsPresent: LangCode[];
  /** Coarse word classes actually present in the current list. */
  posPresent: PosCategory[];
}) {
  const { t } = useI18n();
  const active = activeFilterCount(filters);
  const { lo, hi } = confBounds(filters);

  // Escape still closes it (a keyboard user shouldn't have to tab back to the
  // funnel) — but a click OUTSIDE does not: the panel is part of the page now, and
  // filtering is an activity you move in and out of while reading the rows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // No title bar: the Filter button above the panel already names it and closes it,
  // so a header would only repeat itself. "Clear all" lives in a footer, shown only
  // when there is something to clear.
  return (
    <div className="filtermenu__box" role="group" aria-label={t("lists.filterAria")}>
      {langsPresent.length > 0 && (
        // Full width: a selected language unfurls its band row underneath, which a
        // half-width column would wrap badly.
        <section className="filtermenu__section filtermenu__section--wide">
          <h4 className="filtermenu__label">{t("lists.filterLanguage")}</h4>
          <div className="filtermenu__langs">
            {langsPresent.map((code) => {
              const on = filters.langs.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  className={`filtermenu__lang${on ? " filtermenu__lang--on" : ""}`}
                  aria-pressed={on}
                  onClick={() => onChange(toggleLang(filters, code))}
                >
                  {langName(code)}
                </button>
              );
            })}
          </div>

          {/* A selected language reveals its own proficiency scale, pre-checked.
              Absent for a language with no curated framework. */}
          {filters.langs.map((code) => {
            const fw = proficiencyFrameworkFor(code);
            const checked = filters.bands[code] ?? [];
            if (!fw) return null;
            return (
              <div key={code} className="filtermenu__bands">
                <h5 className="filtermenu__sublabel">
                  {langName(code)} · {fw.name}
                </h5>
                <div className="filtermenu__checks">
                  {fw.bands.map((b) => (
                    <Check
                      key={b.value}
                      label={b.label}
                      checked={checked.includes(b.value)}
                      onChange={() =>
                        onChange({
                          ...filters,
                          bands: { ...filters.bands, [code]: toggle(checked, b.value) },
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="filtermenu__section">
        <h4 className="filtermenu__label">{t("lists.filterUsage")}</h4>
        <div className="filtermenu__checks">
          {USAGE_BANDS.map((band) => (
            <Check
              key={band}
              label={t(COMMONNESS_LABEL_KEY[band])}
              checked={filters.usage.includes(band)}
              onChange={() => onChange({ ...filters, usage: toggle(filters.usage, band) })}
            />
          ))}
        </div>
      </section>

      {posPresent.length > 0 && (
        <section className="filtermenu__section">
          <h4 className="filtermenu__label">{t("lists.filterPos")}</h4>
          <div className="filtermenu__checks">
            {posPresent.map((category) => (
              <Check
                key={category}
                label={t(POS_LABEL_KEY[category])}
                checked={filters.pos.includes(category)}
                onChange={() => onChange({ ...filters, pos: toggle(filters.pos, category) })}
              />
            ))}
          </div>
        </section>
      )}

      {/* The study-history axes (RANGES, wide open by default — see services/words/filters). */}
      <section className="filtermenu__section">
        <h4 className="filtermenu__label">{t("lists.filterWhen")}</h4>
        <PeriodSelect
          label={t("lists.added")}
          value={filters.added}
          onChange={(added) => onChange({ ...filters, added })}
          ariaLabel={t("lists.addedAria")}
        />
        <PeriodSelect
          label={t("lists.reviewed")}
          value={filters.reviewed}
          onChange={(reviewed) => onChange({ ...filters, reviewed })}
          ariaLabel={t("lists.reviewedAria")}
        />
      </section>

      <section className="filtermenu__section">
        <h4 className="filtermenu__label">
          {t("lists.confidenceRange", { min: lo, max: hi })}
        </h4>
        {/* dual-thumb range: two inputs overlaid on one track. The thumbs may
            CROSS (no cross-clamping) — see confA/confB in services/words/filters. */}
        <div className="dualrange">
          <div className="dualrange__track" />
          <div
            className="dualrange__fill"
            style={{
              left: `${(lo / CONF_MAX) * 100}%`,
              right: `${((CONF_MAX - hi) / CONF_MAX) * 100}%`,
            }}
          />
          <input
            type="range"
            className="dualrange__input"
            min={CONF_MIN}
            max={CONF_MAX}
            value={filters.confA}
            onChange={(e) => onChange({ ...filters, confA: Number(e.target.value) })}
            aria-label={t("lists.confMinAria")}
          />
          <input
            type="range"
            className="dualrange__input"
            min={CONF_MIN}
            max={CONF_MAX}
            value={filters.confB}
            onChange={(e) => onChange({ ...filters, confB: Number(e.target.value) })}
            aria-label={t("lists.confMaxAria")}
          />
        </div>
      </section>

      {active > 0 && (
        <div className="filtermenu__foot">
          <button
            type="button"
            className="filtermenu__clear"
            onClick={() => onChange(NO_FILTERS)}
          >
            {t("lists.filterClear")}
          </button>
        </div>
      )}
    </div>
  );
}
