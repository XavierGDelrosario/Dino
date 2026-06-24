// Create a user's OWN word (input + meaning typed) and add it to the current
// list. For dictionary words use <AddWord> instead. Presentational — the parent
// supplies the create callback.
import { useState } from "react";
import { targetOptions, type LangCode } from "../../services/language";
import { useI18n } from "../../i18n";
import "./lists.css";

export function AddCustomWord({
  onAdd,
}: {
  onAdd: (p: {
    input: string;
    translation: string;
    sourceLang: LangCode;
    targetLang: LangCode;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [translation, setTranslation] = useState("");
  const [sourceLang, setSourceLang] = useState<LangCode>("JA");
  const [targetLang, setTargetLang] = useState<LangCode>("EN");
  const { t } = useI18n();

  if (!open) {
    return (
      <button className="btn lists__addtoggle" onClick={() => setOpen(true)}>
        {t("lists.addCustomToggle")}
      </button>
    );
  }

  const submit = () => {
    if (!input.trim() || !translation.trim()) return;
    onAdd({ input, translation, sourceLang, targetLang });
    setInput("");
    setTranslation("");
    setOpen(false);
  };

  return (
    <div className="addword">
      <div className="addword__langs">
        <select
          className="select select--sm"
          value={sourceLang}
          onChange={(e) => setSourceLang(e.target.value as LangCode)}
          aria-label={t("lists.wordLangAria")}
        >
          {targetOptions().map((o) => (
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
        aria-label={t("lists.customWordAria")}
      />
      <input
        className="input input--sm"
        value={translation}
        onChange={(e) => setTranslation(e.target.value)}
        placeholder={t("lists.meaningPlaceholder")}
        aria-label={t("lists.customMeaningAria")}
      />
      <button className="btn" onClick={submit} disabled={!input.trim() || !translation.trim()}>
        {t("common.add")}
      </button>
      <button className="iconbtn" onClick={() => setOpen(false)} title={t("common.cancel")}>
        ✕
      </button>
    </div>
  );
}
