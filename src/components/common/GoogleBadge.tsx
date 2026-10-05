// Google's "translated by Google" badge — the attribution its rules ask for beside a
// translation it produced (cloud.google.com/translate/attribution): the official
// artwork, unaltered, linked to Google Translate.
//
// Three official variants, picked by theme in CSS so the badge is right on first paint:
// white on the dark theme; on the light theme the full-colour one, or the greyscale one
// where the badge repeats (`tone="quiet"` — under every sentence of an article, where
// six brand colours per line would shout over the text being studied).
import color1 from "../../assets/google/translated-by-google-color.png";
import color2 from "../../assets/google/translated-by-google-color@2x.png";
import color3 from "../../assets/google/translated-by-google-color@3x.png";
import grey1 from "../../assets/google/translated-by-google-greyscale.png";
import grey2 from "../../assets/google/translated-by-google-greyscale@2x.png";
import grey3 from "../../assets/google/translated-by-google-greyscale@3x.png";
import white1 from "../../assets/google/translated-by-google-white.png";
import white2 from "../../assets/google/translated-by-google-white@2x.png";
import white3 from "../../assets/google/translated-by-google-white@3x.png";
import { useI18n } from "../../i18n";

// Pre-rendered at 1x/2x/3x. Not the pack's SVGs: those set "translated by" as live text
// in Roboto, which Apple devices lack, so the lettering came out in a substitute font.
const ART = {
  color: { src: color1, srcSet: `${color1} 1x, ${color2} 2x, ${color3} 3x` },
  quiet: { src: grey1, srcSet: `${grey1} 1x, ${grey2} 2x, ${grey3} 3x` },
  white: { src: white1, srcSet: `${white1} 1x, ${white2} 2x, ${white3} 3x` },
};

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
      <img className="gbadge__img gbadge__img--light" {...ART[tone]} alt="" />
      <img className="gbadge__img gbadge__img--dark" {...ART.white} alt="" />
    </a>
  );
}
