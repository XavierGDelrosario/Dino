# CEFR — licensing & quality research (English proficiency axis)

> **Research artifact** (deep-research run, 2026-07-09). 17 sources fetched, 25 claims
> adversarially verified (21 confirmed / 4 refuted). Directly resolves
> [`docs/Proficiency.md`](../Proficiency.md) Remaining item **#5 — English/CEFR data**.
> Question: which CEFR-mapped English word list can DINO legally embed + ship, and is a
> word-level CEFR rating actually a better difficulty signal than the corpus frequency
> (wordfreq Zipf) we already ship?

## TL;DR

- **The CEFR level scheme (A1–C2) is safe to reference.** The labels are an
  industry-standard naming convention. Caveat: the Council of Europe **does** hold
  copyright on the CEFR's *descriptive/illustrative scales* (the actual "can-do"
  descriptor prose) and requires written permission to reproduce **those**. Tagging
  words with level labels is not that, so we're clear.
- **Most famous word→level lists are legally unusable** in a commercial app (Oxford,
  Cambridge EVP: proprietary; Kelly: NonCommercial).
- **CEFR-J is the one clean, shippable path** — free for research **and commercial** use
  with citation, and (bonus) it was purpose-built for **Japanese-native English
  learners**, our exact 40% market. Ship it via the MIT-wrapped `Words-CEFR-Dataset` or
  directly, with dual attribution.
- **Quality reality check:** a CEFR override is only a *modest* improvement over the Zipf
  frequency we already have (word-level CEFR is strongly frequency-patterned, and CEFR's
  own descriptor scales are empirically contested). It adds curated, human-checked,
  non-frequency signal — but don't expect a dramatic accuracy jump. Age-of-Acquisition
  actually outpredicts frequency, if we ever want a genuinely stronger signal.

## (1) Licensing — candidate word lists

| List | Coverage | License | Ship in commercial app? | Notes |
|---|---|---|---|---|
| **CEFR-J Vocabulary Profile** (Tono Lab, TUFS) | A1–B2 (~7k words) | Free for research **& commercial**, citation required (informal prose license, **not** OSI/CC) | ✅ **Yes** | Purpose-built for JA-native English learners; splits CEFR's 6 levels into 12 because coarse CEFR poorly discriminates JA learners clustered at A1–A2 |
| **Octanove Vocabulary Profile** (C1/C2 extension to CEFR-J) | C1–C2 | CC BY-SA 4.0 | ✅ Yes (attribution + share-alike) | Fills CEFR-J's thin top end; **different** license to track separately |
| **Words-CEFR-Dataset** ([Maximax67](https://github.com/Maximax67/Words-CEFR-Dataset)) | A1–B2 | MIT wrapper, **but levels derived from CEFR-J** | ✅ Yes | Most practical drop-in. MIT can't relicense CEFR-J values → must attribute **both** MIT notice **and** CEFR-J/Tono Lab. Community repo — read the actual LICENSE file before shipping |
| **Oxford 3000 / 5000** | A1–C1 (no C2) | © Oxford University Press; "Oxford 5000"™; no CC/permission | ❌ **No** | Structurally ideal (discrete band headings), legally unusable — every page carries the © notice, no redistribution grant |
| **Cambridge EVP** (English Vocabulary Profile) | A1–C2, **sense-level** | Proprietary Cambridge; free to *browse* only | ❌ No | Highest quality (sense-level, grounded in the Cambridge Learner Corpus) but no redistribution license; access needs registration |
| **Kelly lists** | A1–C2 | CC BY-**NC**-SA 2.0 | ❌ No | NonCommercial clause blocks it. Only the *Swedish* Kelly list is non-NC (irrelevant to English). Also part frequency-derived, so not independent of our Zipf signal |

**Attribution family match:** CEFR-J's "free for commercial use with citation" and
Octanove's CC BY-SA 4.0 are the same permissive-with-attribution family DINO already ships
under for wordfreq (CC-BY-SA) and JMdict (EDRDG). No new legal posture.

## (2) Quality — is CEFR a better difficulty signal than frequency?

Only **modestly**, and the literature is more skeptical than the marketing:

- **Word-level CEFR is strongly patterned by corpus frequency.** In an ML study
  (Bosch et al. 2025, *Nature* Humanities & Social Sciences Communications), corpus
  frequency was the single most influential predictor of a word's CEFR level. So a CEFR
  override is **not independent** of the Zipf data we already have.
  - Verification caveat: two *stronger* phrasings were **refuted** (0–3) — CEFR is **not**
    "largely recoverable from frequency alone," and Oxford levels are **not** "substantially
    a frequency-derived signal." So the honest read is *frequency-dominant but not fully
    reducible*: a CEFR override adds curated non-frequency signal (POS, polysemy,
    human review), but the marginal difficulty gain over frequency is small.
- **CEFR itself is empirically contested.** Peer-reviewed validation (Wisniewski 2018,
  *Applied Linguistics* 39(6):933; Weir 2005, *Language Testing* 22(3)) found the
  vocabulary/fluency descriptor scales (A2–B2) empirically flawed — some scale contents
  barely observable or too evenly distributed to distinguish learners; learner language
  often couldn't be matched to any level. These critiques target the **proficiency
  descriptors**, not word ratings per se, but they caution against treating any CEFR
  level as precisely calibrated. (The 2018/2020 Companion Volume addressed some gaps.)
- **A curated layer can beat frequency — but the winner may be AoA, not CEFR.**
  Age-of-Acquisition outpredicted frequency for text difficulty (Kuperman norms; Cambridge
  *SSLA* 2025 random-forest: AoA Gini importance **127** vs frequency-related lexical-decision
  time **54**). E.g. *pizza* (AoA 4.7) is easier than *physics* (AoA 11.7) despite lower
  frequency. This is a *text-level* result and AoA/frequency are themselves correlated, but
  it says the bigger difficulty win might come from an AoA norms table, not any CEFR list.

**Verdict:** CEFR-J is worth adopting for the **curated-level-wins-over-frequency**
precedence we already model (a frequent-but-abstract word isn't beginner) and because it
matches our market — **not** because it's a dramatically better difficulty estimator than
Zipf. Manage expectations accordingly.

## Integrating into DINO

**The code seam is already done.** `services/proficiency/registry.ts` already maps
`EN → CEFR` (`bandsFromLabels(["A1","A2","B1","B2","C1","C2"])`), and
`services/difficulty` already reads `word.proficiencyBand` through
`fromProficiency()` with the correct precedence
(`override ?? proficiency ?? frequency`). **Nothing in `registry.ts` needs to change.**
What remains is the **data pipeline**, and one non-obvious **attachment-point** problem:

1. **Get the wordlist** → derive `data/proficiency/en.tsv` (`<surface>\t<band>`,
   easiest = 1: A1→1 … C2→6) from CEFR-J (via `Words-CEFR-Dataset` or direct), matching
   `scripts/build-proficiency.py`'s output format. Follow the "add another framework"
   steps in `docs/Proficiency.md`.

2. **⚠️ Attachment point (the real gap).** `scripts/ingest-jmdict.ts` joins
   `data/proficiency/<lang>.tsv` onto `jmdict_kanji/kana.proficiency_band` — those are
   **Japanese** surfaces. English source words (EN→JA lookups, where `words.input` is the
   English word) are **not in JMdict**; they're projected by the edge function via the
   WordNet/gloss path. So the JMdict-ingest join **cannot** attach English CEFR bands.
   English needs a **different** join, e.g.:
   - a small server-side `cefr_en (surface → band)` lookup table the **edge function
     consults when projecting EN-source `words` rows** (mirrors how frequency/POS ride
     inline), or
   - a post-projection band backfill keyed on `words.input` for `source_lang = 'EN'`.

   This is the same reason `learn_words_at_band` is "JA→EN/JLPT only today." Reaching the
   JA-native-English-learner market end-to-end means an **English source retrieval** for
   the Learn/Calibration flows too, not just the band tag.

3. **Attribution** → add the CEFR-J + Octanove entries to `ATTRIBUTION.md` (drafted below;
   already added there, marked *planned* until the data ships) and the in-app footer
   (`AttributionFooter.tsx`).

### Drafted `ATTRIBUTION.md` entry (also added to the file, marked planned)

```markdown
## Proficiency band — CEFR / English (`data/proficiency/en.tsv`) — PLANNED

The English proficiency-label signal (the CEFR band, `proficiency_band` for EN source
words) is derived from the **CEFR-J Vocabulary Profile** (© Yukio Tono / Tono Lab,
Tokyo University of Foreign Studies), distributed via **Open Language Profiles**
(https://github.com/openlanguageprofiles/olp-en-cefrj), optionally packaged through the
MIT-licensed **Words-CEFR-Dataset** (https://github.com/Maximax67/Words-CEFR-Dataset).

- The CEFR-J Vocabulary/Grammar Profile "can be used for research and commercial purposes
  with no charge, provided that you cite the dataset properly." Citation to
  **Tono Lab, TUFS** is required. (Informal prose license from the copyright holder — not
  a standard OSI/CC license; legal review advised before ship.)
- The **Words-CEFR-Dataset** MIT wrapper permits commercial use with attribution, but its
  CEFR levels are DERIVED from CEFR-J, so the CEFR-J citation is still owed — attribute
  BOTH the MIT notice AND CEFR-J/Tono Lab.
- The C1/C2 **Octanove Vocabulary Profile** extension (if used to fill CEFR-J's thin top
  end) is **CC BY-SA 4.0** — attribution + share-alike, tracked separately.

We ship only the derived `<surface>\t<band>` numbers, not the source files. CEFR is a
framework of the **Council of Europe**; we reference the level labels only and reproduce
none of its copyrighted descriptor scales.
```

## Before shipping (checklist)

- [ ] Read the actual `Words-CEFR-Dataset` LICENSE file + confirm the exact CEFR-J citation
      string (informal license → a quick legal glance is prudent for a commercial product).
- [ ] Decide surface-form vs sense-level: CEFR-J is largely surface-form; our `words` schema
      is per-sense. One CEFR value per surface is acceptable (frequency is already per-surface).
- [ ] Coverage: CEFR-J is A1–B2-weighted (C-levels thin → that's what Octanove CC-BY-SA 4.0
      backfills, under a different license).
- [ ] Solve the English **attachment point** (§2 above) — the JMdict ingest join won't cover it.

## Open questions

1. Sense-level vs surface-level CEFR tags, and what our per-sense `words` schema needs.
2. Exact CEFR-J attribution string, and whether "proper citation" is satisfied by the
   in-app footer + `ATTRIBUTION.md` (as with wordfreq/JMdict) or needs more.
3. Would a psycholinguistic **AoA norms** table (Kuperman) be a better-licensed and more
   predictive difficulty override than any CEFR list? (AoA outpredicted frequency.)
4. How much does a CEFR override actually shift DINO's difficulty bins vs pure Zipf in
   practice — is the engineering + attribution burden justified for the JA-native segment?

## Sources

Primary / peer-reviewed:
- Bosch et al. 2025, *Humanities & Social Sciences Communications* — https://www.nature.com/articles/s41599-025-05446-y
- Wisniewski 2018, *Applied Linguistics* 39(6):933 — https://academic.oup.com/applij/article-abstract/39/6/933/3063135
- Weir 2005, *Language Testing* 22(3), "Limitations of the CEF…" — https://www.researchgate.net/publication/249870162
- Cambridge *SSLA* 2025, aligning linguistic complexity with CEFR text difficulty — https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/aligning-linguistic-complexity-with-the-difficulty-of-english-texts-for-l2-learners-based-on-cefr-levels/DB604DB02A205F0F172D6024137CBFE8
- Computational-linguistics context on EVP — https://arxiv.org/pdf/2506.02758

Datasets / licenses (primary):
- Open Language Profiles (CEFR-J + Octanove) — https://github.com/openlanguageprofiles/olp-en-cefrj
- Words-CEFR-Dataset (MIT) — https://github.com/Maximax67/Words-CEFR-Dataset
- Kelly project (CC BY-NC-SA) — https://ssharoff.github.io/kelly/ · https://spraakbanken.gu.se/en/projects/kelly
- Oxford 3000/5000 (proprietary) — https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000
- Cambridge English Vocabulary Profile — https://englishprofile.org

**Refuted in verification (do not rely on):**
- "CEFR word levels are largely recoverable from frequency alone" (0–3).
- "Oxford CEFR levels are substantially a frequency-derived signal" (0–3).
- "CEFR's six levels are derived from Can-do perceptions rather than empirical measures" (1–2).
- cefrlookup.com's claimed 40/30/20/10 weighting methodology (0–3) — unreliable source.
