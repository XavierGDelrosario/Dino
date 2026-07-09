# Word-frequency sources — research & decision

Researched **2026-07-09**. Question: keep or supplement **wordfreq** (our current JA/EN
frequency source), given two gaps — (a) it's **surface-only**, so homograph readings can't
be split (辛い → からい vs つらい get one number), and (b) its tokenizer **splits multi-kanji
compounds** (唐揚げ). Deciding factors throughout: **commercial licensing** + **reading
disambiguation**.

## Bottom line

- **Commercial-safe (ship derived numbers):** wordfreq (CC-BY-SA), **SUBTLEX-US** (CC-BY-SA
  + explicit any-purpose grant), **TUBELEX** (BSD-3), **MeCab** (BSD) + **UniDic** (elect its
  BSD arm), Leipzig (CC-BY/SA), JA Wikipedia dump (CC-BY-SA).
- **NOT commercially usable — avoid:** **BCCWJ** published frequency lists (research/education
  only, no commercial grant), **NTT 日本語の語彙特性** (paid CD-ROM), **jpdb.io** (proprietary),
  **COCA** (paid), **Google *syntactic* Ngrams** (NC), anime/Netflix subtitle scrapes
  (copyrighted media, no license), **BCCWJ-WLSP** sense list (CC-BY-**NC**-SA).

## The two things we wanted, and the verdicts

### Per-reading frequency (からい vs つらい) — build our own; don't ship BCCWJ
- **BCCWJ** is the obvious candidate and *does* carry readings — its SUW list keys on
  `語彙素 (lemma) + 語彙素読み (lemma reading, katakana) + 品詞`, so 辛い/カライ and 辛い/ツライ are
  **distinct rows with distinct counts**. Its LUW list also gives **whole-word compound**
  counts (fixes 唐揚げ). Lists are a **free download** (no registration; DOI 10.15084/00003218).
  **BUT the license is research/education-only — no commercial grant.** Commercial use is a paid
  NINJAL contract (¥400k–¥8M). Community repackagings (Yomitan BCCWJ dicts) inherit the
  restriction. → **We cannot ship BCCWJ-derived numbers.**
- **The clean path = build it ourselves:** **MeCab (BSD) + UniDic (BSD arm)** over a **Japanese
  Wikipedia dump (CC-BY-SA)**. UniDic emits `語彙素 + 語彙素読み + 発音` per token, so counting on
  `(lemma, reading)` yields the からい/つらい split **natively**. Join by **surface AND reading**
  onto `jmdict_kanji`/`jmdict_kana` (JMdict already stores the readings). Derived TSV stays
  **CC-BY-SA** — the *same* licensing regime as today's `data/frequency/ja.tsv`, no new legal
  model; an hours-scale one-shot ETL like `build-frequency.py`.
  - Caveats: Wikipedia skews encyclopedic (proper-noun-heavy, less spoken); UniDic short-unit
    segmentation still splits some compounds differently from JMdict headwords (the 唐揚げ join
    reconciliation persists); runtime kuromoji uses IPADIC, so build-time (UniDic) ≠ runtime
    analyzer unless standardized.
- **Per-SENSE frequency: not available commercially at all** (only BCCWJ-WLSP, which is NC).
  JMdict/WordNet carry no per-sense frequency. So per-reading is the achievable ceiling.

### English frequency (secondary market — we have none yet)
- **SUBTLEX-US — recommended.** Best learner fit (subtitle frequency predicts word processing
  better than written corpora, ~62% vs 57–60% variance) **and** cleanest license (CC-BY-SA +
  Brysbaert's explicit "any purpose, not just academic" permission). 51M words / 74k forms.
- **wordfreq EN** — zero-friction second choice; identical CC-BY-SA posture to our JA pipeline,
  drops straight into `build-frequency.py`.
- Avoid: **COCA** (paid), **Google Books Ngrams** (print-only, OCR bias, worst learner fit).

## Other JA candidates (for the record)
| Source | Register | Readings | Compounds | Commercial |
|---|---|---|---|---|
| **TUBELEX** (NAIST, YouTube subs) | spoken/everyday | lemma+POS, no kana | whole-word | **BSD-3 ✅** |
| **wareya/jpstats** (VN+narou) | media/novels | surface only | — | **CC0 ✅** (no provenance) |
| **adno/wikipedia-word-frequency-clean** | encyclopedic | no | yes | **BSD-3 ✅** |
| Leipzig Corpora | mixed | no | no | CC-BY/SA ✅ |
| NTT 語彙特性 | written + familiarity | **per-reading** | whole-word | **paid ❌** |
| jpdb.io / Innocent / anime decks | immersion | some | some | **no license ❌** |
| CC100 / OSCAR / mC4 | web | no | tokenizer-dep | murky (Common Crawl ToU) |

## Recommendation for DINO — supplement, don't replace

1. **Keep wordfreq** as the base Zipf magnitude for both languages (works, CC-BY-SA, matches
   `ATTRIBUTION.md`).
2. **Add English now:** **SUBTLEX-US** (best + cleanest) → `data/frequency/en.tsv`; or wordfreq
   EN for zero friction. Unblocks English leveling for the secondary market.
3. **Biggest JA leveling win (incremental, not urgent):** build a **reading-keyed** JA frequency
   with **MeCab + UniDic over JA Wikipedia** — the *only* licensing-clean path to the
   からい/つらい split, plus better compound counts. Join by surface **and reading**.
4. **Optional spoken-register axis:** **TUBELEX (BSD-3)** if we want a media/spoken difficulty
   signal for the "study-the-media" thread (no kana, but JMdict supplies readings; use for
   magnitude only).
5. **Avoid:** BCCWJ lists, NTT, jpdb/Innocent/anime scrapes, COCA, Google syntactic ngrams.

**Priority note:** we just fixed the surface-frequency *baseline* (own-frequency, migration
`20260720`), so the reading-split is now an **incremental refinement**, not a correctness fix —
worthwhile (からい ≫ つらい in reality), but a supplement. English frequency (SUBTLEX-US) is the
higher-value, lower-effort next step.

## Key URLs
- BCCWJ list https://clrd.ninjal.ac.jp/bccwj/en/freq-list.html · fee https://clrd.ninjal.ac.jp/bccwj/fee.html
- UniDic commercial license https://clrd.ninjal.ac.jp/unidic/en/commerce_use_en.html · MeCab https://taku910.github.io/mecab/
- TUBELEX https://github.com/naist-nlp/tubelex · SUBTLEX-US http://crr.ugent.be/programs-data/subtitle-frequencies
- wordfreq https://github.com/rspeer/wordfreq · JA Wikipedia dumps https://dumps.wikimedia.org/legal.html
- BCCWJ-WLSP (sense, NC) https://github.com/masayu-a/BCCWJ-WLSP
