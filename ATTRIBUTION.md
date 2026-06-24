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
