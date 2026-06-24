// Look a word up in the dictionary and add it to the current list — the meaning
// comes from the dictionary, not typed. AUTO-ADDS the primary sense, shows what
// it picked, and offers the other meanings (in case the primary was wrong, e.g.
// 辛い → からい when you meant つらい). Presentational: the parent supplies the
// lookup + save callbacks.
import { useState } from "react";
import {
  sourceOptions,
  targetOptions,
  AUTO_DETECT,
  type LangCode,
  type SourceSelection,
} from "../../services/language";
import type { Word } from "../../services/words/repository";
import { SenseText } from "../common/SenseText";
import { useI18n } from "../../i18n";
import "./lists.css";

export function AddWord({
  lookup,
  onSave,
}: {
  lookup: (p: {
    input: string;
    sourceLang: SourceSelection;
    targetLang: LangCode;
  }) => Promise<{ input: string; meanings: Word[] }>;
  onSave: (word: Word) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sourceLang, setSourceLang] = useState<SourceSelection>(AUTO_DETECT);
  const [targetLang, setTargetLang] = useState<LangCode>("EN");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ input: string; meanings: Word[] } | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [showOthers, setShowOthers] = useState(false);
  const { t } = useI18n();

  const reset = () => {
    setResult(null);
    setSaved(new Set());
    setShowOthers(false);
    setErr(null);
  };

  if (!open) {
    return (
      <button className="btn lists__addtoggle" onClick={() => setOpen(true)}>
        {t("lists.addWordToggle")}
      </button>
    );
  }

  // Look up, then auto-add the primary sense.
  const submit = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    reset();
    try {
      const r = await lookup({ input, sourceLang, targetLang });
      if (r.meanings.length === 0) {
        setErr(t("lists.noMatchFor", { input: r.input }));
        return;
      }
      setResult(r);
      await onSave(r.meanings[0]); // auto-add primary
      setSaved(new Set([r.meanings[0].wordId]));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addOther = async (w: Word) => {
    if (saved.has(w.wordId)) return;
    try {
      await onSave(w);
      setSaved((s) => new Set(s).add(w.wordId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const primary = result?.meanings[0];
  const others = result?.meanings.slice(1) ?? [];

  return (
    <div className="addword addword--lookup">
      <div className="addword__row">
        <div className="addword__langs">
          <select
            className="select select--sm"
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            aria-label={t("lists.wordLangAria")}
          >
            {sourceOptions().map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="langbar__arrow">→</span>
          <select
            className="select select--sm"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value as LangCode)}
            aria-label={t("lists.meaningLangAria")}
          >
            {targetOptions().map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <input
          className="input input--sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("lists.wordPlaceholder")}
          aria-label={t("lists.wordLookupAria")}
        />
        <button className="btn" onClick={submit} disabled={!input.trim() || busy}>
          {busy ? "…" : t("common.add")}
        </button>
        <button
          className="iconbtn"
          onClick={() => {
            setOpen(false);
            setInput("");
            reset();
          }}
          title={t("common.close")}
        >
          ✕
        </button>
      </div>

      {err && <pre className="review__error">{err}</pre>}

      {primary && (
        <div className="addword__result">
          <div className="addword__added">
            {t("lists.addedPrefix")} <SenseText word={primary} />
          </div>

          {others.length > 0 && (
            <>
              <button className="results__more" onClick={() => setShowOthers((v) => !v)}>
                {showOthers ? t("lists.hideOthers") : t("lists.otherMeanings", { n: others.length })}
              </button>
              {showOthers && (
                <ul className="addword__others">
                  {others.map((w) => (
                    <li key={w.wordId} className="sense">
                      <span className="sense__text">
                        <SenseText word={w} />
                      </span>
                      <button
                        className={`sense__add${saved.has(w.wordId) ? " sense__saved" : ""}`}
                        onClick={() => addOther(w)}
                        disabled={saved.has(w.wordId)}
                      >
                        {saved.has(w.wordId) ? "✓" : "＋"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
