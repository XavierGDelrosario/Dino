# Estimated levels for unranked words — and how good the JLPT list is

**Measured 2026-09-28** against the local DB (JMdict common subset, wordfreq JA, the JLPT
ingest after `apply:proficiency`). Ships as migration `20260777_level_estimate.sql`.

## 1. How reliable the reference (Waller's JLPT list) is

Checked against an independent source: NINJAL's 1984 *日本語教育のための基本語彙調査*
(22 experts rated each word 0/1/2 for "first ~2,000 / within ~6,000 words to learn";
CC BY 4.0, https://mmsrv.ninjal.ac.jp/bvjsl84/). 3,914 of Waller's 7,813 words are rated.

| Waller | n | median expert score (0–40) | "first 2,000" (≥30) |
|---|---|---|---|
| N5 | 481 | 36 | 73% |
| N4 | 401 | 31 | 57% |
| N3 | 1,296 | 22 | 17% |
| N2 | 869 | 16 | 3% |
| N1 | 867 | 13 | 0.6% |

- Expert score tracks Waller's order better than frequency does (Spearman 0.65 vs 0.51,
  same 3,816 words). Sharp contradictions: 13 of 3,914 (0.3%).
- **N5–N3 are corroborated; N2 vs N1 is not** — the experts' scale stops at "basic 6,000",
  so both score alike (16.6 vs 14.5). Frequency can't split them either (medians 0.02 Zipf apart).

## 2. Frequency → level, and why the rule is shaped as it is

Scored with 5-fold CV on 7,085 levelled content words (grammar / affixes / interjections /
names excluded). "Too hard" = shown later than the true level (a test surprise, the
costlier error); "flooding" = shown 2+ levels easier.

- A single frequency estimate is weak: 34% exact; its rare N1 calls are 20% right.
- Tilting easier trades the two errors in every level; no setting avoids both.
- **Unranked words are almost never basic**: 20 of 12,723 (0.16%) are expert "first
  2,000" words. So an **N3 floor** is nearly free on the population it's used for.
- On true N3–N1 words, medium tilt (the easiest band ≥25% of a bin sit at or below) +
  N3 floor: **41% exact, 3.5% one level too hard, 0% two or more, 0 words on N5/N4.**
- NINJAL as a clamp cuts flooding but only covers 3.5% of unranked words — not used.

## 3. Coverage

Unranked content entries (local, 15,147): with the Zipf 3.0 cutoff, 8,312 (55%) get an
estimate — all common/mid words. Below Zipf 3 stays Unranked on purpose (mostly beyond
the JLPT; "N2" would tell a learner to know them). Prod lookups: ~91% of looked-up words
carry a frequency, so coverage there is higher than the dictionary-wide figure.

## 4. Revision (20260779): word shape × teaching lists, stored

The frequency-only rule over-filled N3: it called advanced news/business compounds
(苦悩, 配属, 給付, 月収) N3. Measured on staging's full JMdict (58.9k headwords):

- **Word shape matters.** Among listed kanji compounds at Zipf 3.5–4.0 only 21% are
  N3-or-easier (52% N1); kanji compounds need Zipf ≳ 4.5 before most are N3.
- **Teaching-list membership matters more.** Kanji compounds at Zipf 3.5–5.0 on a NINJAL
  teaching list: 48% ≤N3, 30% N1; on none: 20% ≤N3, **63% N1**. 85% of unranked words are
  on no list.
- **JMdict's `common` flag is useless here** (1,985 of 1,992 such compounds carry it), and a
  stricter N3 bar only trades one error for the other.

Scored on listed words that are on no teaching list (the unranked population's shape):
frequency-only 28% exact → **50% with shape × list**; N1 correctly called N1 8% → 56%;
N1 shown as N3 51% → 44%; true N3 shown harder 16% → 22%. Dictionary-wide estimates move
from N3 47% / N2 53% / N1 0% to roughly N3 34% / N2 3% / N1 63%.

The membership signal needs per-word data, so the RESULT is computed once and stored
(`estimated_band` on the dictionary writings + `words`) rather than storing the list or
mirroring a rule on the client. Storage: < 1 MB.

## 5. Next

A Claude classifier, scored on the levelled words before trusting it (~$3 for a
Haiku/Sonnet/Opus comparison; ~$1–9 to fill the ~34k common prod words, batch). The same
N3 floor applies on top of any estimator.
