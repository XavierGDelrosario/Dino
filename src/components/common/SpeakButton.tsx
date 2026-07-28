// The shared "listen" affordance — flashcards, list rows, and both translate boxes.
// Renders NOTHING when the platform has no voice for the language, so a device
// without Japanese installed shows no dead buttons rather than silent ones.
//
// The click is stopped from propagating on purpose: this button sits inside a
// flashcard (a click flips it), a selectable list row (a click picks it), and the
// calibration swipe stage. Listening should never also do one of those.
import { SpeakerIcon } from "./icons";
import { useSpeak } from "../../hooks/useSpeak";
import { useI18n } from "../../i18n";
import type { LangCode } from "../../services/language";
import "./speak.css";

export function SpeakButton({
  text,
  lang,
  className = "iconbtn",
  size,
}: {
  /** Exactly what to pronounce — callers pass pronounceableText(word) for a word. */
  text: string;
  /** Language of the TEXT (not the UI locale). */
  lang: LangCode;
  className?: string;
  size?: number;
}) {
  const { available, speaking, speak } = useSpeak(lang);
  const { t } = useI18n();
  if (!available || !text.trim()) return null;

  const label = t(speaking ? "voice.stop" : "voice.speak");
  return (
    <button
      type="button"
      className={`${className} speakbtn${speaking ? " speakbtn--on" : ""}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        speak(text);
      }}
    >
      <SpeakerIcon size={size} />
    </button>
  );
}
