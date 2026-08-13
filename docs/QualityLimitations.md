# Quality limitations — free tier, free sources, free options

Status **2026-07-29**. An honest audit of where DINO's *content/data quality* is
currently capped, grouped by the three constraints that drive it: **Supabase free-tier
storage**, **quality of the free/open source data**, and **choosing free tiers of paid
services**. Each item notes the fix / upgrade that removes it.

> Framing: the **dictionary + translation core is solid on the free tier** (full JMdict +
> Japanese WordNet + wordfreq). The quality ceiling is concentrated in the **derived
> signals** — leveling, per-surface granularity, and English being under-built. (The
> word-map was removed in `20260741`; see §1.) Nothing here is a correctness bug; these are *quality ceilings*.

---

## 1. Supabase free tier (500 MB DB) — storage-driven

- **The word-map (embeddings) is REMOVED — 2026-07-31, migration `20260741`.** It was
  80 MB of a 500 MB tier (prod sat at 434 MB, 87% full) and powered exactly one feature,
  "Explore related words", plus the #12 domain quiz built on the same RPC. Its quality
  was also poor in a specific way: with `multilingual-e5-small` (384-dim) katakana
  loanwords clustered by **spelling**, not meaning (ストライカー → ストリーカー / ストリッパー,
  with the truly related ピッチャー last). The fix — a 1024-dim model — roughly TRIPLES
  vector storage, which is precisely what would have forced Pro. Dropping it removed
  that pressure instead of paying for it: **prod 434 → 354 MB**, staging 428 → 348 MB.
  **Reversible:** `scripts/build-embeddings.py` and the creating migration both remain;
  the client half is recoverable from git history. Reconsider the LLM route first — one
  "write a paragraph at level X using these seed words" call collapses #11+#12 with no
  vectors at all.
- **No hosted automated backups / PITR.** Off-site export exists (`npm run db:backup`), but
  point-in-time recovery + managed backups are a paid toggle. Durability/ops gap, not
  content, but real. **Fix:** Pro (deploy-time toggle).
- **Headroom, after the word-map removal: ~146 MB** (354 of 500 used). That has to absorb
  growth, not just data — the `words` cache grows with every new lookup, and the planned
  `sentence_cache` and any media caching grow with usage. A **second language's**
  dictionary is still the real Free→Pro trigger; no single feature is.

## 2. Source quality (free / open data)

- **JLPT proficiency is approximate + single-source.** `data/proficiency/ja.tsv` (Waller /
  tanos via jamsinclair) is unofficial, ~decade-old, **±1-level noisy**, N3 is pure
  interpolation, per-**surface** (not per-sense), and covers only ~8k surfaces (the rest
  fall to frequency). Critically, **every free JLPT list traces to the same Waller source**,
  so consensus-voting buys ~nothing for Japanese (see the leveling note in `TODO.md`). No
  official post-2010 list exists to validate against. **Fix:** license an independent list
  (prep-book-derived); otherwise this is a hard ceiling.
  - **How far the list reaches, measured on prod 2026-07-29:** of 6,604 JA `words` rows,
    **1,656 (25%) carry no band** — down from 3,100 (47%) before migration `20260740`.
    That migration recovered 1,444 of them, and the split matters for knowing what is
    left: **1,178** were levels the dictionary already had, lost to a stale cache;
    **266** were lost to the shown-writing rule (below); only the remaining ~1,217 are
    genuinely absent from the source. So the *hard* ceiling is ~19% of rows, not 47% —
    the rest was ours to fix.
- **A band is per-ENTRY; frequency stays per-SURFACE (`20260740`).** These two axes look
  alike and must not be resolved alike. Frequency belongs to the SPELLING — `20260720`
  stopped a rare kanji borrowing its common kana's count (亡い reading ない's 704). JLPT
  levels the WORD, so when the shown writing has no band it now falls back to the entry's
  kanji writing; without that, every "usually kana" entry (こと 事 · いる 居る · ため 為 ·
  よう 様 · ご 御) read as unlevelled. The fallback is **kanji-only on purpose**: falling
  back to the entry's kana re-creates the borrowing bug in the proficiency axis, since a
  kana surface is where unrelated words collide (疎雨 "drizzle" would take N4 off the
  adverb そう; 犯る would be labelled N5 off やる). ~171 kana-only rows stay unlevelled as
  the price of that.
- **Frequency measures COMMONNESS, not LEVEL.** wordfreq is adult/written-text-skewed (的 is
  ~12th-most-frequent kanji yet N3), and its tokenizer **can't rank multi-kanji compounds**
  (唐揚げ splits → no whole-word frequency → NULL). The **borrowed-kana** issue (a rare kanji
  inheriting its common kana's Zipf — 亡い showed ない's 704) is now **FIXED** (migration
  `20260720`: `jmdict_entry_headword` + `jmdict_lookup` use the SHOWN writing's OWN value,
  matching `learn_words_at_band`; verified live 2026-07-09). Remaining, and NOT fixable from
  wordfreq: it's **surface-only, not per-reading** — からい and つらい (both 辛い) can't have their
  counts split, because the corpus records the string, not the reading. **Fix for that** (researched
  2026-07-09, `docs/research/Frequency_Sources.md`): BCCWJ has the readings but is research/education-
  license only (can't ship); the clean path is **build our own** reading-keyed list with MeCab+UniDic
  (BSD) over a JA Wikipedia dump (CC-BY-SA), keyed on `(語彙素, 語彙素読み)`. Incremental, not urgent.
- **JMdict gloss / sense quality.** Excellent coverage, but sense ordering sometimes surfaces
  obscure meanings first (橋→"pons Varolii", 粉→"decimetre"), glosses are terse, and there are
  **no example sentences, no register/formality labels** beyond POS/misc tags. **Fix:** a
  commercial dictionary layer / curated sense re-ranking / example-sentence corpus (Tatoeba,
  jreibun — licensing TBD).
- **Everything is per-SURFACE or per-ENTRY, never per-SENSE.** Frequency is one-per-headword;
  the proficiency band is one-per-entry since `20260740`. Either way a
  homograph (辛い → からい/つらい) or any polysemous word gets **one band, one frequency, one
  vector for all meanings**. A real granularity ceiling across all
  three derived axes. **Fix:** engineering (per-sense schema + ingest), not money — arguably
  the single biggest *content-model* limitation.
- **English leveling — frequency DONE, proficiency + embeddings remain.** EN difficulty used
  to borrow the matched JA entry's frequency; **fixed 2026-07-09** — `english_frequency` table
  (migration `20260721`) + `data/frequency/en.tsv` (321k wordfreq surfaces) + an edge override
  applies the ENGLISH input's own frequency on EN→JA projection (verified live: penguin=378,
  serendipity=274). **CEFR proficiency also DONE 2026-07-09** — `data/proficiency/en.tsv` (8,845
  surfaces, CEFR-J + Octanove) → `english_proficiency` table (migration `20260722`) → edge override
  stamps the ENGLISH input's CEFR band (verified: wonderful→A1, reluctantly→C1). So English now has
  BOTH a difficulty axis AND a curated level label (which leads over frequency).
- **No WRITTEN pronunciation for English — deferred on purpose, and cheap when we want it.**
  EN rows carry no IPA or stress (`input_reading` is NULL on all **5,923** of them), so a
  JA-native learner sees the spelling and nothing about how to say it. **Low priority
  because the app already SPEAKS the word:** `services/voice` is output-only, free, keyless
  and quota-less, and gates a listen button wherever a word is shown. What **CMUdict**
  (BSD-2-Clause, commercial OK, attribution) adds over audio is a *skimmable* phoneme +
  stress string sitting next to the word — keep the stress digits, since stress matters as
  much as phonemes for JA natives. **Cost, measured on prod 2026-08-13: ~13 MB.** CMUdict
  0.7b's 133,854 entries at ~98 B/row, extrapolated from `english_frequency`'s measured
  44.3 B/row heap + 34.6 B/row index with its int swapped for a ~22-char ARPABET string
  (ASCII; IPA is multibyte and larger); plus ~140 KB to backfill the EN `words` rows and
  ~4 MB of TSV in the repo, next to the 3.7 MB `data/frequency/en.tsv`. Prod is at 336.9 of
  500 MB, so ~8% of what's left. One-time — no API, no per-use cost; the only recurring
  cost is one extra serial round-trip on the EN→JA **miss** path beside the three existing
  `applyEnglish*`/`applySenseExamples` awaits, and the per-environment ingest chore (it
  won't be in `db:dump-seed`, so a fresh env is silently NULL until someone runs it).
  - **Shape when built:** its own migration + server-only `english_pronunciation (surface
    PK, …)` + its own `npm run ingest:english-pronunciation`, applied at projection with a
    one-shot backfill — mirroring `english_frequency` / `english_proficiency`. Never folded
    into a `wordnet_*` re-ingest.
  - ⚠️ **`words.input_reading` is not a free landing slot.** It renders as ruby with no
    schema change, but `fetchVerified` / `fetchVerifiedMany` match `input` **OR
    `input_reading`** in BOTH directions, so a phonetic string silently becomes a cache
    lookup key and feeds `preferWrittenForm`'s primary-slot choice (the 質 → たち class of
    bug). A separate nullable column is inert but needs the ruby wired. Decide before
    ingesting — reversing it later means rewriting cached rows.
- **MT fallback (Google) is single-sense, reading-less.** Words JMdict lacks get one Google
  gloss, no reading, no multi-sense — lower quality than dictionary entries.

## 3. Free tiers of paid services

- **No licensed JLPT/CEFR list** → the consensus-voting idea can't help Japanese (all free =
  Waller); for English the best sources (Cambridge EVP, Oxford) are paid.
- **Google MT is cost-rationed** → the whole-paragraph gloss + JMdict-miss words run behind a
  kill-switch + per-user/global quotas, so under load they degrade to "JMdict-only" (no result
  for uncovered words).
- **No LLM features (no `ANTHROPIC_API_KEY`)** → no generated example sentences, no definitions
  *in the learning language*, no "write a paragraph at level X" (which could collapse #12 into
  one call). All gated on a paid API.

## Cross-cutting

- **Leveling is approximate by construction** (approximate JLPT that leads + commonness-biased
  frequency that fills gaps + a coarse ±1 calibration). This is *acceptable and documented*,
  not a bug — but the app should never present a level as authoritative (UI copy = "~N3").
- **`users.level` axis reconciliation is open** now that word difficulty is proficiency-preferred
  (see `TODO.md` leveling note).

---

## The highest-impact levers (and what unlocks each)

1. **EN→JA sense quality** — the direction users actually report as weak. WordNet synsets
   lead, the JMdict gloss search fills, and the grouping has **never been live-verified**
   (does `spring` come back 春/泉/ばね, sense-distinct?). **Unlock: verification + tuning**,
   not money — no licensable free EN→JA dictionary beats what is already ingested.
2. **Per-SENSE granularity** for proficiency / frequency — fixes homograph mis-leveling;
   the biggest *content-model* ceiling. **Unlock: engineering**, not money.
3. **An independent JLPT list** — every free list traces to Waller, so ~1,656 of 6,604 JA
   rows carry no band and consensus-voting buys nothing. **Unlock: licensing.**

## What is NOT a shortcoming (solid on free tier)

- **Full JMdict** dictionary coverage (prod runs the full ~217k-entry `jmdict-eng`).
- **Japanese WordNet** semantic EN→JA (synset-grouped, sense-disambiguated).
- **wordfreq** frequency as the dense difficulty substrate + ordering signal.
- Translation core, RLS/data model, cost controls — all robust on free.
