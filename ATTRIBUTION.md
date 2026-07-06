# Attribution & data licenses

DINO bundles third-party data. This file records the required attributions and the
licenses that govern redistribution of that data and our derivatives of it.

## Word frequency / difficulty (`data/frequency/*.tsv`)

Our per-word difficulty signal is derived from **wordfreq**
(https://github.com/rspeer/wordfreq) by Robyn Speer.

- wordfreq's **code** is Apache-2.0; its **data** is **CC-BY-SA 4.0**.
- `data/frequency/*.tsv` is a **derivative** of that data (a normalized Zipf score
  per surface form, computed by `scripts/build-frequency.py`). As required by
  CC-BY-SA 4.0, **this derived file is licensed under CC-BY-SA 4.0**
  (https://creativecommons.org/licenses/by-sa/4.0/) and may be redistributed under
  the same terms with attribution. (Only the derived numbers are shipped — never
  the source corpora.)

wordfreq aggregates several corpora; per its NOTICE, attribution is owed to the
underlying sources, including:

- **OPUS OpenSubtitles 2018** — subtitle text (attribution to OpenSubtitles).
- **SUBTLEX** — Marc Brysbaert et al.
- **Google Books Ngrams**, **Wikipedia**, **ParaCrawl**, and others (see wordfreq's
  NOTICE.md for the full per-language source list).

Note: wordfreq is frozen at a ~2021 snapshot (no longer maintained). This is
acceptable here — word difficulty is stable — but regeneration won't pull newer data.

## Dictionary (JMdict)

The dictionary content (`jmdict_*` tables, ingested via `scripts/ingest-jmdict.ts`
from the scriptin/jmdict-simplified release) is **JMdict**, owned by the
**Electronic Dictionary Research and Development Group (EDRDG)** and used under the
EDRDG license (https://www.edrdg.org/edrdg/licence.html). Attribution to EDRDG is
required; the user-facing notice ships in the app footer
(`src/components/common/AttributionFooter.tsx`).

## Semantic EN→JA (Japanese WordNet)

The EN→JA semantic lookup (`wordnet_*` tables, ingested via
`scripts/ingest-wordnet.ts`) is derived from the **Japanese WordNet** (wnja, v1.1)
from the bond-lab / NICT project (https://bond-lab.github.io/wnja/). It maps
Princeton WordNet synsets to Japanese words; English-lemma → synset data and the
Japanese mappings come from the released `wnjpn.db` + `wnjpn-ok.tab` files.

- The **Japanese WordNet data** is distributed under a **BSD-like (3-clause)
  license** (NICT, Francis Bond et al.); attribution required.
- The **English / synset structure** derives from **Princeton WordNet**, used under
  the **WordNet License** (https://wordnet.princeton.edu/license-and-commercial-use)
  — a BSD-style permissive license requiring the Princeton copyright notice be
  retained.

We ship only the derived `wordnet_*` numbers/mappings (synset ids, lemmas, sense
ranks), not the original release files. The user-facing app footer notice
(`AttributionFooter.tsx`) credits these sources alongside JMdict.

## Proficiency band — JLPT (`data/proficiency/ja.tsv`)

The Japanese proficiency-label signal (the JLPT band shown as extra info, and the
level-quiz filter — the `proficiency_band` column, built by
`scripts/build-proficiency.py`) is derived from the per-level vocabulary lists in
**jamsinclair/open-anki-jlpt-decks** (https://github.com/jamsinclair/open-anki-jlpt-decks),
which are in turn based on **Jonathan Waller's JLPT lists** (tanos.co.uk) via
chyyran/jlpt-anki-decks.

- The **open-anki-jlpt-decks** repository is licensed under the **MIT License**.
- The JLPT itself publishes **no** official post-2010 vocabulary list; these
  community lists are an approximation of each N-level's vocabulary.

We ship only the derived `<surface>\t<band>` numbers (surface → 1..5, easiest→hardest),
not the original CSVs. JLPT® is a registered trademark of the Japan Foundation and
JEES; this project is not affiliated with or endorsed by them.
