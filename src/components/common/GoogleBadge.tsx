// Google's "translated by Google" badge — the attribution its rules ask for beside a
// translation it produced (cloud.google.com/translate/attribution): the official
// artwork, unaltered, linked to Google Translate.
//
// Three official variants, picked by theme in CSS so the badge is right on first paint:
// white on the dark theme; on the light theme the full-colour one, or the greyscale one
// where the badge repeats (`tone="quiet"` — under every sentence of an article, where
// six brand colours per line would shout over the text being studied).
import color from "../../assets/google/translated-by-google-color.svg";
import greyscale from "../../assets/google/translated-by-google-greyscale.svg";
import white from "../../assets/google/translated-by-google-white.svg";
import { useI18n } from "../../i18n";

export function GoogleBadge({
  tone = "color",
  size = "regular",
  className = "",
}: {
  tone?: "color" | "quiet";
  size?: "regular" | "small";
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <a
      className={`gbadge${size === "small" ? " gbadge--small" : ""}${className ? ` ${className}` : ""}`}
      href="https://translate.google.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("translate.translatedByGoogle")}
      // It sits inside tappable text (a sentence toggles its translation on tap).
      onClick={(e) => e.stopPropagation()}
    >
      <img className="gbadge__img gbadge__img--light" src={tone === "quiet" ? greyscale : color} alt="" />
      <img className="gbadge__img gbadge__img--dark" src={white} alt="" />
    </a>
  );
}
