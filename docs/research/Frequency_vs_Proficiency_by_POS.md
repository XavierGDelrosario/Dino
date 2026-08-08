# Frequency vs proficiency: how far apart are they, and why

**Measured 2026-07-14** against the local DB (JMdict common subset + wordfreq JA + the JLPT
proficiency ingest): 7,523 kanji surfaces that carry BOTH a curated JLPT band and a corpus
frequency. Reproduce any number here by re-running the queries inline.

The question this answers: **can corpus frequency stand in for a curated learner level?**
It matters because the SRS wants to know "is this word comfortably below this user" in order
to retire words they clearly know — and only 3.4% of the dictionary has a curated band.

---

## 1. Frequency is a weak proxy for learner level

| | |
|---|---|
| Correlation (band ↔ frequency) | r = −0.489, **R² = 0.24** |
| Frequency bin exactly matches the band | 31.5% |
| Within one level | 78.2% |
| **Frequency says ≥2 levels EASIER** (the dangerous direction) | **14.7%** |
| Frequency says ≥2 levels harder (harmless) | 7.1% |
| Mean absolute error | **0.96 levels** (SD 1.24, bias −0.31) |

Frequency explains about a quarter of the variance in JLPT level. Within a single band,
word frequencies span nearly the whole Zipf range — N3 words run from Zipf 1 to 6 — so no
correction recovers a signal that isn't there.

```sql
SELECT count(*), corr(proficiency_band, frequency),
       avg(abs(difficulty_from_frequency(frequency) - proficiency_band)) AS mae
  FROM jmdict_kanji WHERE proficiency_band IS NOT NULL AND frequency IS NOT NULL;
```

## 2. Coverage runs the other way

| | curated band | frequency |
|---|---|---|
| Whole JMdict (kanji surfaces) | **3.4%** | 21.7% |
| Words users actually look up (`words` cache, JA) | 60% | **91%** |

So the band is the better signal and the frequency is the only *available* one. Neither can
be dropped; they must be combined, comparing like with like (band-vs-band or
frequency-vs-frequency, never crossed — the user side has both too).

## 3. The disagreement is POS-structured — and the cause is measurable

Frequency here is **per-surface**. Inflection splits a word's corpus mass across its forms
(食べる only counts that exact string, not 食べた/食べます/食べて), while affixes and counters
never inflect and so concentrate all of theirs on one surface.

Measured as each POS group's mean Zipf **relative to the median frequency of its own JLPT band**
(i.e. isolating the POS effect from the global bin/band miscalibration):

| POS group | words | mean Zipf | vs its band's median | ≥2 levels too easy |
|---|---|---|---|---|
| **affix / counter** | 444 | 4.77 | **+0.60** | 31.3% |
| other | 78 | 4.45 | +0.19 | 14.1% |
| noun | 3,873 | 4.01 | +0.06 | 17.7% |
| adjective | 1,071 | 3.95 | −0.02 | 13.3% |
| adverb | 220 | 4.09 | −0.06 | 9.2% |
| **verb** | 1,164 | 3.29 | **−0.76** | **0.9%** |

Affixes are the *most frequent* class in the dictionary and among the *hardest* by JLPT
(第, 化, 系, 感, 等 are all N2). Verbs are the opposite: they look rarer than they are, and are
therefore almost never over-rated as easy. The correlation is near-identical across classes
(−0.48 … −0.58), so what differs is **bias, not noise** — and bias is correctable.

## 4. The correction must be asymmetric

Correcting every POS *toward* the band improves symmetric error (MAE 0.96 → 0.85) but
**breaks verbs**: shifting them toward the band means shifting them *easier*, which blew their
risky rate from 0.9% to 15%. The loss here is asymmetric — over-retiring a word is expensive,
over-reviewing it is nearly free — so the correction may only ever nudge a word **harder**:

```
affix / counter : −0.60 Zipf     (make it look rarer/harder than its raw frequency)
other           : −0.19
noun            : −0.06
adjective / adverb / verb : no correction   (their bias already runs in the safe direction)
```

## 5. Everything above is Japanese-specific

- **English inflects far less** (4 verb forms, not dozens), has no counters, and CEFR is 6
  bands to JLPT's 5 — so both the offsets and the band anchors differ.
- **There is no English POS source at all.** `words.part_of_speech` on an EN-source row holds
  **JMdict Japanese tags describing the Japanese translation** (`pension` → `{n, adj-no}`).
  Any "POS correction" applied to an English word today would be correcting English frequency
  with a Japanese tag.
- `english_frequency` / `english_proficiency` were empty on the measurement DB, so the same
  analysis has never been run for English. It must be, before English gets a profile.

**Conclusion:** one language-agnostic ease calculator, a per-language leveling profile as
reference data (measured, not hand-written), and ease capped by signal quality — 2.5× when a
curated band produced the level, 1.6× when only frequency did. See the leveling entry in
`docs/TODO.md`.

## 6. What would settle it properly

All of the above scores frequency against **JLPT as ground truth**, and JLPT is itself only a
proxy for the real question ("does this user already know this word?"). Several of the
"errors" are cases where frequency is probably the better judge — 日本, 考え, 感じ are N3 words
that any N3 learner knows cold. JLPT bands measure *when a word is formally taught*; frequency
measures *how much exposure you've had*.

The honest resolution is to log `word_level`, `user_level`, `ease` and `retrievability` on every
`review_log` row and regress **actual recall** against them. That data cannot be backfilled, so
the columns should land before the ease does.
