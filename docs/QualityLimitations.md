# Quality limitations — free tier, free sources, free options

Status **2026-07-09**. An honest audit of where DINO's *content/data quality* is
currently capped, grouped by the three constraints that drive it: **Supabase free-tier
storage**, **quality of the free/open source data**, and **choosing free tiers of paid
services**. Each item notes the fix / upgrade that removes it.

> Framing: the **dictionary + translation core is solid on the free tier** (full JMdict +
> Japanese WordNet + wordfreq). The quality ceiling is concentrated in the **derived
> signals** — leveling, the word-map (embeddings), per-surface granularity, and English
> being under-built. Nothing here is a correctness bug; these are *quality ceilings*.

---

## 1. Supabase free tier (500 MB DB) — storage-driven

- **The word-map (embeddings, #11/#12) is trimmed to ~45k words.** The full dictionary is
  ~217k entries, but `build-embeddings.py` embeds only the "fat common" set (frequency
  floor 250 → ~41–45k). Rare/long-tail words have **no embedding** → no "related words"
  and no domain expansion for them. Pure storage decision: full dict (~243 MB) + 384-dim
  embeddings (~165 MB) already sits near the 500 MB ceiling.
  **Fix:** Supabase Pro (8 GB) → embed the full dict.
- **Embedding *quality* is capped by the small model.** `multilingual-e5-small` (384-dim)
  produces the documented **katakana-loanword clustering bug** (related words come back a
  *spelling* family, not a *meaning* family — ストライカー→ストリーカー/ストリッパー). The fix
  (`multilingual-e5-large` 1024-dim or LaBSE) roughly **triples** vector storage (~415 MB)
  → **forces Pro**. So loanword relatedness is bad *because of the tier*.
  **Fix:** Pro + re-embed with a 1024-dim model (`vector(384)` column migration + re-embed).
- **No hosted automated backups / PITR.** Off-site export exists (`npm run db:backup`), but
  point-in-time recovery + managed backups are a paid toggle. Durability/ops gap, not
  content, but real. **Fix:** Pro (deploy-time toggle).
- **Thin headroom.** Full dict leaves ~180 MB, which embeddings mostly consume. A **second
  language's** dict + embeddings crosses Free→Pro — multilingual ambition is the real
  Free→Pro trigger, not any single feature.

## 2. Source quality (free / open data)

- **JLPT proficiency is approximate + single-source.** `data/proficiency/ja.tsv` (Waller /
  tanos via jamsinclair) is unofficial, ~decade-old, **±1-level noisy**, N3 is pure
  interpolation, per-**surface** (not per-sense), and covers only ~8k surfaces (the rest
  fall to frequency). Critically, **every free JLPT list traces to the same Waller source**,
  so consensus-voting buys ~nothing for Japanese (see the leveling note in `TODO.md`). No
  official post-2010 list exists to validate against. **Fix:** license an independent list
  (prep-book-derived); otherwise this is a hard ceiling.
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
- **Everything is per-SURFACE, not per-SENSE.** Proficiency band, frequency, AND embeddings
  are one-per-headword — so a homograph (辛い → からい/つらい) or any polysemous word gets **one
  band, one frequency, one vector for all meanings**. A real granularity ceiling across all
  three derived axes. **Fix:** engineering (per-sense schema + ingest), not money — arguably
  the single biggest *content-model* limitation.
- **English leveling — frequency DONE, proficiency + embeddings remain.** EN difficulty used
  to borrow the matched JA entry's frequency; **fixed 2026-07-09** — `english_frequency` table
  (migration `20260721`) + `data/frequency/en.tsv` (321k wordfreq surfaces) + an edge override
  applies the ENGLISH input's own frequency on EN→JA projection (verified live: penguin=378,
  serendipity=274). **CEFR proficiency also DONE 2026-07-09** — `data/proficiency/en.tsv` (8,845
  surfaces, CEFR-J + Octanove) → `english_proficiency` table (migration `20260722`) → edge override
  stamps the ENGLISH input's CEFR band (verified: wonderful→A1, reluctantly→C1). So English now has
  BOTH a difficulty axis AND a curated level label (which leads over frequency). Still open: **no EN
  embeddings** (word-map) — storage/Pro-gated, so "Explore related words" stays JA-only.
- **MT fallback (Google) is single-sense, reading-less.** Words JMdict lacks get one Google
  gloss, no reading, no multi-sense — lower quality than dictionary entries.

## 3. Free tiers of paid services

- **No licensed JLPT/CEFR list** → the consensus-voting idea can't help Japanese (all free =
  Waller); for English the best sources (Cambridge EVP, Oxford) are paid.
- **Free embedding model** → the loanword-clustering bug above.
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

## The 3 highest-impact levers (and what unlocks each)

1. **Bigger embedding model + full-dict embeddings** — fixes loanword relatedness AND extends
   the word-map to rare words. **Unlock: Supabase Pro** (storage).
2. **Per-SENSE granularity** for proficiency / frequency / embeddings — fixes homograph
   mis-leveling; the biggest *content-model* ceiling. **Unlock: engineering**, not money.
3. **English CEFR data + EN frequency** — the secondary market is currently almost unleveled.
   **Unlock: the CEFR research + a licensable list** (CEFR-J likely free).

## What is NOT a shortcoming (solid on free tier)

- **Full JMdict** dictionary coverage (prod runs the full ~217k-entry `jmdict-eng`).
- **Japanese WordNet** semantic EN→JA (synset-grouped, sense-disambiguated).
- **wordfreq** frequency as the dense difficulty substrate + ordering signal.
- Translation core, RLS/data model, cost controls — all robust on free.
