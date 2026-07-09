# Data license & attribution audit

> **As of 2026-07-09.** Scope: every third-party **dataset** DINO ships (or plans to) and
> whether its license permits our commercial use + redistribution of derivatives, and
> whether attribution is in place. Source of truth for the terms: [`ATTRIBUTION.md`](../../ATTRIBUTION.md).
> This does **not** cover npm/code dependencies (separate audit) — only bundled data.

## Standard

DINO is a commercial app that **embeds and redistributes derived data** (Zipf numbers,
band tags, synset mappings). Each dataset must therefore satisfy: (a) commercial use
allowed, (b) redistribution of our derivative allowed, (c) attribution requirements met,
(d) any share-alike obligation understood and honored.

## Findings

| Dataset | Ships as | License | Commercial + redistribute? | Attribution in place? | Notes / gaps |
|---|---|---|---|---|---|
| **JMdict** (dictionary) | `jmdict_*` tables | EDRDG license | ✅ Yes (attribution required) | ⚠️ Footer notice exists (`AttributionFooter.tsx`); confirm it renders in prod before launch | Launch-blocking legal must (`docs/TODO.md` #15) |
| **wordfreq** (frequency/difficulty) | `data/frequency/*.tsv` | Data CC-BY-SA 4.0 (code Apache-2.0) | ✅ Yes — our derived TSV is **CC-BY-SA 4.0** (share-alike) | ✅ `ATTRIBUTION.md` + underlying corpora credited | Share-alike: our derived file must stay CC-BY-SA. Frozen ~2021 snapshot |
| **Japanese WordNet** (EN→JA semantic) | `wordnet_*` tables | BSD-like (NICT) + Princeton WordNet License | ✅ Yes (retain notices) | ✅ `ATTRIBUTION.md` + footer | Keep Princeton copyright notice |
| **JLPT lists** (JA proficiency band) | `data/proficiency/ja.tsv` | MIT (open-anki-jlpt-decks) | ✅ Yes (attribution) | ✅ `ATTRIBUTION.md` | JLPT® trademark disclaimer present; community list ≈ official |
| **CEFR-J** (EN proficiency band) | `data/proficiency/en.tsv` — **PLANNED, not yet shipped** | Free for commercial use w/ citation (informal prose) | ✅ Yes — pending legal read of the informal license | ⚠️ Drafted in `ATTRIBUTION.md` (marked *planned*); footer entry TODO | See [research](../research/CEFR_Licensing_And_Quality.md). Dual-attribute CEFR-J + MIT wrapper if via `Words-CEFR-Dataset` |
| **Octanove** (CEFR C1/C2, optional) | (only if used to fill C-levels) | CC BY-SA 4.0 | ✅ Yes (attribution + share-alike) | ⚠️ Add if adopted | Different license from CEFR-J — track share-alike separately |

## Rejected / must-not-ship (documented so they don't creep back in)

- **Oxford 3000 / 5000** — © Oxford University Press, trademarked, no redistribution grant. ❌
- **Cambridge English Vocabulary Profile (EVP)** — proprietary Cambridge; browse-only. ❌
- **Kelly lists** — CC BY-**NC**-SA (NonCommercial blocks our use). ❌

## Open gaps

1. **JMdict/WordNet footer** — verify the EDRDG + WordNet attribution actually renders in
   the deployed build (launch-blocking, `docs/TODO.md` #15).
2. **CEFR-J** — before shipping `en.tsv`: legal read of the informal CEFR-J license text,
   confirm the exact citation string, and add the footer entry (currently only drafted in
   `ATTRIBUTION.md`).
3. **Octanove** — only if C1/C2 coverage is added; then honor CC-BY-SA share-alike.
