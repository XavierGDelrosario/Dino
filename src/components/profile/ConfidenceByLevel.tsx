// "Confidence by level": one horizontal bar per proficiency band (easy → hard, then
// unranked), its length the band's average display confidence on the 0–5 scale and its
// colour the confidence ramp step it rounds to — the same --conf-N the dots and the
// reader use, so a bar and the words it describes can't disagree. The word count per
// level sits beside it: an average over 3 words and one over 800 read differently.
import { useI18n } from "../../i18n";
import { CONFIDENCE_COLORS } from "../../services/analyze/palette";
import { bandRows, type ProfileHistory } from "../../services/history";
import "./history.css";

export function ConfidenceByLevel({ history }: { history: ProfileHistory }) {
  const { t } = useI18n();
  const rows = bandRows(history.bands, history.mainLang, t("history.unranked"));
  if (rows.length === 0) return <p className="hist__empty">{t("history.empty")}</p>;

  return (
    <ul className="hist-levels">
      {rows.map((r) => {
        const v = r.avgConf ?? 0;
        const step = Math.max(0, Math.min(5, Math.round(v)));
        const words = t("history.words", { n: r.n });
        return (
          <li key={r.band} className="hist-levels__row" title={`${r.label}: ${v.toFixed(1)} / 5 · ${words}`}>
            <span className="hist-levels__label ellipsis">{r.label}</span>
            <span className="hist-levels__track" aria-hidden="true">
              <span
                className="hist-levels__fill"
                style={{ width: `${(v / 5) * 100}%`, background: CONFIDENCE_COLORS[step] }}
              />
            </span>
            <span className="hist-levels__value">
              <strong>{v.toFixed(1)}</strong>
              <span className="hist-levels__n">{words}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
