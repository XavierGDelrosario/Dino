// Required data-source attribution (legal must-before-public, #15) + the legal-page
// links. Credits the dictionary (JMdict/EDRDG), the frequency data (wordfreq,
// CC-BY-SA), and the semantic EN→JA source (Japanese WordNet + Princeton WordNet).
// Full detail + license terms live in ATTRIBUTION.md.
import { useI18n } from "../../i18n";
import { Link } from "../../router";

export function AttributionFooter() {
  const { t } = useI18n();
  return (
    <footer className="app__footer">
      <p className="app__footer-links">
        <Link to="/privacy">{t("legal.privacy")}</Link>
        {" · "}
        <Link to="/terms">{t("legal.terms")}</Link>
      </p>
      Dictionary data from{" "}
      <a href="https://www.edrdg.org/jmdict/j_jmdict.html" target="_blank" rel="noopener noreferrer">
        JMdict
      </a>
      , © the{" "}
      <a href="https://www.edrdg.org/" target="_blank" rel="noopener noreferrer">
        Electronic Dictionary Research and Development Group
      </a>
      , used under the{" "}
      <a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noopener noreferrer">
        EDRDG licence
      </a>
      . Word-frequency data derived from{" "}
      <a href="https://github.com/rspeer/wordfreq" target="_blank" rel="noopener noreferrer">
        wordfreq
      </a>{" "}
      (
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">
        CC BY-SA 4.0
      </a>
      ). English↔Japanese sense data from the{" "}
      <a href="https://bond-lab.github.io/wnja/" target="_blank" rel="noopener noreferrer">
        Japanese WordNet
      </a>{" "}
      and{" "}
      <a href="https://wordnet.princeton.edu/" target="_blank" rel="noopener noreferrer">
        Princeton WordNet
      </a>
      .
    </footer>
  );
}
