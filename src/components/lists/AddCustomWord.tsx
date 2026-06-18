// Create a user's OWN word (input + meaning typed) and add it to the current
// list. For dictionary words use <AddWord> instead. Presentational — the parent
// supplies the create callback.
import { useState } from "react";
import { targetOptions, type LangCode } from "../../services/language";
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

  if (!open) {
    return (
      <button className="btn lists__addtoggle" onClick={() => setOpen(true)}>
        ＋ Add custom word
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
          aria-label="Word language"
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
          aria-label="Meaning language"
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
        placeholder="Word"
        aria-label="Custom word"
      />
      <input
        className="input input--sm"
        value={translation}
        onChange={(e) => setTranslation(e.target.value)}
        placeholder="Meaning"
        aria-label="Custom meaning"
      />
      <button className="btn" onClick={submit} disabled={!input.trim() || !translation.trim()}>
        Add
      </button>
      <button className="iconbtn" onClick={() => setOpen(false)} title="Cancel">
        ✕
      </button>
    </div>
  );
}
