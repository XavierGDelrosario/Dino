// Required data-source attribution (legal must-before-public, #15). Credits the
// dictionary (JMdict/EDRDG) and the frequency data (wordfreq, CC-BY-SA). Full
// detail + license terms live in ATTRIBUTION.md; this is the user-facing notice.
export function AttributionFooter() {
  return (
    <footer className="app__footer">
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
      ).
    </footer>
  );
}
