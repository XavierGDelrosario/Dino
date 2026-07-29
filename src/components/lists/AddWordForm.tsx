// ONE add-a-word form for the Lists screen — the merge of the old <AddWord>
// (dictionary lookup) and <AddCustomWord> (type your own meaning). Shaped like the
// Translate surface: a word field, a MEANING field, and Translate + Add at the
// bottom.
//
// The two old flows were the same act ("put this word in my list") split by where
// the meaning came from, which forced the user to choose the mechanism before
// knowing whether the dictionary even has the word. Here the meaning field is just
// EDITABLE: Translate fills it from the dictionary, and anything you type over it
// (or type without translating at all) is your own meaning. Which write happens is
// inferred at Add time, not chosen up front:
//
//   meaning === the selected dictionary sense  → saveDictionaryWord (keeps the
//                                                sense's reading/POS/frequency)
//   anything else (typed / edited / no lookup) → createCustomWord (standalone)
//
// So the custom-word path is the fallback of one flow rather than a separate form.
//
// The form is a BLOCK below the actions row (the view owns open/closed and renders
// the "+ Add word" toggle) — not a floating card: it holds text inputs the user works
// in, so it pushes the rows down rather than covering them.
import { useEffect, useState } from "react";
import {
  dictionaryForm,
  resolveSourceLanguage,
  sourceOptions,
  targetOptions,
  swapLanguages,
  type LangCode,
  type SourceSelection,
} from "../../services/language";
import { useLanguagePrefs } from "../../hooks/useLanguagePrefs";
import { errorMessage } from "../../lib/errorMessage";
import { nfcTrim } from "../../lib/text";
import type { Word } from "../../services/words/repository";
import { SenseText } from "../common/SenseText";
import { useI18n } from "../../i18n";
import { ErrorText } from "../common/ErrorText";
import { LangPair } from "./LangPair";
import { InputField } from "../common/InputField";
import "./lists.css";

export function AddWordForm({
  userId,
  lookup,
  onSaveSense,
  onAddCustom,
  onClose,
}: {
  /** Whose language prefs seed the direction (same source as Translate's). */
  userId: string;
  lookup: (p: {
    input: string;
    sourceLang: SourceSelection;
    targetLang: LangCode;
  }) => Promise<{ input: string; meanings: Word[] }>;
  /** Save a dictionary sense as-is (meaning untouched). */
  onSaveSense: (word: Word) => Promise<void>;
  /** Create the user's own word (meaning typed or edited). Only completion matters
   *  here — the resolved value (useLists' guard reports success as a boolean) is
   *  the caller's business, not this form's. */
  onAddCustom: (p: {
    input: string;
    translation: string;
    sourceLang: LangCode;
    targetLang: LangCode;
  }) => Promise<unknown>;
  /** Close the form (the view owns whether it is open). */
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [meaning, setMeaning] = useState("");
  // Same direction Translate opens on: you type the language you're LEARNING and
  // read the meaning in your NATIVE one. Seeded from the profile prefs (registry
  // defaults for a fresh guest), then freely flippable with ⇄.
  const prefs = useLanguagePrefs(userId);
  const [sourceLang, setSourceLang] = useState<SourceSelection>(prefs.learning);
  const [targetLang, setTargetLang] = useState<LangCode>(prefs.native);
  useEffect(() => {
    setSourceLang(prefs.learning);
    setTargetLang(prefs.native);
  }, [prefs]);
  // The sense the meaning field currently holds, if it came from a lookup and is
  // still untouched — this is what makes Add a dictionary save rather than a custom one.
  const [senses, setSenses] = useState<Word[]>([]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const { t } = useI18n();

  /** Drop everything transient: the looked-up senses, the error, the "added" flash.
   *  Every path that invalidates the current result calls exactly this. */
  const resetResult = () => {
    setSenses([]);
    setSelected(null);
    setShowOthers(false);
    setErr(null);
    setAdded(null);
  };

  const close = () => {
    setInput("");
    setMeaning("");
    resetResult();
    onClose();
  };

  // Editing the WORD invalidates a dictionary meaning sitting in the output (it
  // describes the old word) — but never a meaning the user typed themselves.
  const changeInput = (value: string) => {
    setInput(value);
    if (selected && meaning === selected.translation) setMeaning("");
    resetResult();
  };

  const translate = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    resetResult();
    try {
      // Look up the DICTIONARY FORM, not the surface: the dictionary is keyed on
      // lemmas, so a conjugated 行った matches nothing (and in prod would fall
      // through to paid MT for a word JMdict has under 行く). Same rule Translate
      // and the paragraph reader use. JA only — no engine gives English lemmas.
      const query = await dictionaryForm(input, resolveSourceLanguage(input, sourceLang));
      const r = await lookup({ input: query, sourceLang, targetLang });
      if (r.meanings.length === 0) {
        // Not a failure: the word just isn't in the dictionary. Type a meaning and
        // Add still works (as a custom word).
        setErr(t("lists.noMatchFor", { input: r.input }));
        return;
      }
      setSenses(r.meanings);
      setSelected(r.meanings[0]);
      // Show the headword we actually resolved to (行った → 行く, ねこ → 猫) — it's
      // what Add will save, so the field must not keep saying something else.
      setInput(r.meanings[0].input);
      setMeaning(r.meanings[0].translation); // the primary; other senses are one click away
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const word = nfcTrim(input);
    const translation = nfcTrim(meaning);
    if (!word || !translation || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // NFC-compare (the app's text-boundary convention): a canonically-equal meaning
      // the user retyped — or an IME's decomposed form — is still THE dictionary
      // sense, and must not silently take the custom path and drop its reading/POS.
      if (selected && translation === nfcTrim(selected.translation)) {
        await onSaveSense(selected);
      } else {
        await onAddCustom({
          input: word,
          translation,
          // A custom word needs a concrete language — resolve "detect" against the text.
          sourceLang: resolveSourceLanguage(word, sourceLang),
          targetLang,
        });
      }
      setInput("");
      setMeaning("");
      resetResult();
      setAdded(word); // after the reset — this flash outlives it
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const others = senses.slice(1);

  return (
    <div className="addword addword--lookup">
      <div className="addword__row">
        <LangPair
          source={sourceLang}
          onSource={setSourceLang}
          target={targetLang}
          onTarget={(v) => setTargetLang(v as LangCode)}
          // Flip the LANGUAGES, and move the text with them ONLY when there is an
          // output to move — the word slot holds the source-language term, so text
          // that stays behind would sit under the wrong label. Cases:
          //   output filled → swap the fields (the "I only know the English" flow:
          //     it lands in the word slot, ready to look up)
          //   output empty  → leave the input alone. Swapping here would empty the
          //     word you just typed into the output slot, which is never what you want.
          onSwap={() => {
            const flipped = swapLanguages(sourceLang, targetLang);
            setSourceLang(flipped.source);
            setTargetLang(flipped.target);
            if (meaning.trim()) {
              setInput(meaning);
              setMeaning(input);
            }
            resetResult(); // the looked-up sense belongs to the old direction
          }}
          sourceOptions={sourceOptions()}
          targetOptions={targetOptions()}
          sourceAria={t("lists.wordLangAria")}
          targetAria={t("lists.meaningLangAria")}
        />
        <button className="iconbtn addword__close" onClick={close} title={t("common.close")}>
          ✕
        </button>
      </div>

      {/* No Enter-to-submit: the Japanese IME uses Enter to confirm kanji. */}
      <InputField
        className="input input--sm"
        value={input}
        onChange={changeInput}
        placeholder={t("lists.wordPlaceholder")}
        ariaLabel={t("lists.wordLookupAria")}
      />
      <InputField
        className="input input--sm"
        value={meaning}
        onChange={(v) => {
          setMeaning(v);
          setAdded(null);
        }}
        placeholder={t("lists.meaningPlaceholder")}
        ariaLabel={t("lists.customMeaningAria")}
      />
      <p className="addword__hint">{t("lists.addHint")}</p>

      {/* The senses Translate didn't put in the field — click one to use it instead. */}
      {others.length > 0 && (
        <div className="addword__result">
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
                    className={`sense__add${selected?.wordId === w.wordId ? " sense__saved" : ""}`}
                    onClick={() => {
                      setSelected(w);
                      setMeaning(w.translation);
                    }}
                    title={t("lists.useMeaning")}
                  >
                    {selected?.wordId === w.wordId ? "✓" : "＋"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ErrorText message={err} />
      {added && (
        <div className="addword__added">
          {t("lists.addedPrefix")} {added}
        </div>
      )}

      <div className="addword__actions">
        <button className="btn" onClick={translate} disabled={!input.trim() || busy}>
          {busy ? "…" : t("translate.submit")}
        </button>
        <button
          className="btn btn--primary"
          onClick={add}
          disabled={!input.trim() || !meaning.trim() || busy}
        >
          {t("common.add")}
        </button>
      </div>
    </div>
  );
}
