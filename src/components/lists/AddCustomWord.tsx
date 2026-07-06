// Create a user's OWN word (input + meaning typed) and add it to the current
// list. For dictionary words use <AddWord> instead. Presentational — the parent
// supplies the create callback.
import { useState } from "react";
import { targetOptions, type LangCode } from "../../services/language";
import { useI18n } from "../../i18n";
import { LangPair } from "./LangPair";
import { InputField } from "../common/InputField";
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
      <LangPair
        source={sourceLang}
        onSource={(v) => setSourceLang(v as LangCode)}
        target={targetLang}
        onTarget={(v) => setTargetLang(v as LangCode)}
        sourceOptions={targetOptions()}
        targetOptions={targetOptions()}
        sourceAria={t("lists.wordLangAria")}
        targetAria={t("lists.meaningLangAria")}
      />
      <InputField
        className="input input--sm"
        value={input}
        onChange={setInput}
        placeholder={t("lists.wordPlaceholder")}
        ariaLabel={t("lists.customWordAria")}
      />
      <InputField
        className="input input--sm"
        value={translation}
        onChange={setTranslation}
        placeholder={t("lists.meaningPlaceholder")}
        ariaLabel={t("lists.customMeaningAria")}
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
