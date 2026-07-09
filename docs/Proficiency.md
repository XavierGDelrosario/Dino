# Proficiency label axis (JLPT / CEFR / …)

Status as of **2026-07-07**. The **data pipeline is built + verified end-to-end on
local**; the two user-facing features (a per-word badge, a level-based quiz) and
the prod deploy are **not done yet** (see [Remaining](#remaining)).

## What it is

A **curated, per-language proficiency label** for a word — "N3" for Japanese
(JLPT), "B2" for English (CEFR) — shown as extra info and (later) used to filter a
level-based new-words quiz.

It is deliberately its **own axis**, kept separate from the two others and never
conflated:

| Axis | Source | Question it answers | Lives in |
| --- | --- | --- | --- |
| **Proficiency** (this) | curated wordlist (JLPT/CEFR) | "what level is this word?" | `words.proficiency_band` + `services/proficiency` |
| **Difficulty** | corpus frequency (wordfreq Zipf) | "how common/hard is this?" | `words.frequency` + `services/difficulty` |
| **Relatedness** | embeddings (pgvector) | "what's near this in meaning?" | `word_embeddings` + `services/embeddings` |

Proficiency is a *sparse, authoritative label*; frequency is the *dense, universal*
difficulty substrate. They can co-exist on a word; neither replaces the other.

**Precedence update (2026-07-09):** the two *columns* stay separate, but the DIFFICULTY
resolver now **prefers the curated proficiency level over frequency** —
`getDifficulty = override ?? proficiency ?? frequency` (`services/difficulty`). Rationale:
corpus frequency measures COMMONNESS, not learner LEVEL (的 is ~12th-most-frequent kanji
yet N3), so where a curated JLPT/CEFR band exists it's the right answer to "how hard for a
learner"; frequency is the dense proxy for the ~96% of words with no band, plus ordering
within a level. `getProficiency` is unchanged (pure label). See the leveling note in
`docs/TODO.md` for the (still-open) downstream user-level/axis reconciliation.

## Design decisions

1. **One generic concept, NOT a per-language feature.** A framework is a *named,
   ordered set of bands for one language*. Adding a language's scale is **data** (a
   wordlist + a one-line registry entry), never new schema or UI. This is the
   anti-sprawl guard: JLPT is registry entry #1, CEFR #2; HSK/TOPIK are each one
   more of the same.
2. **The band is a raw ordinal; the framework is derived from `source_lang`.** One
   nullable scalar column (`words.proficiency_band`), not `jlpt_level` + `hsk_level`
   + … . The client registry maps `(lang, band) → label` (JA→JLPT, EN→CEFR).
3. **Convention: `proficiency_band` is ALWAYS ascending = harder**, regardless of
   how the framework *labels* itself. JLPT labels count DOWN (N5 easy → N1 hard), so
   ingest maps **N5→1 … N1→5**; CEFR/HSK count up (A1/HSK1→1). So the raw integer is
   a valid per-language ordering with **no normalization**. Frameworks differ in
   band COUNT (JLPT 5, CEFR/HSK 6) — that count is *data* in the registry, never a
   shared assumption. (Cross-language comparability is the only thing normalization
   would buy; it's a free read-time add if ever needed, and isn't stored.)
4. **Mirrors `frequency` exactly** for the data path (per-surface source column →
   `jmdict_lookup` takes the headword's value → edge projects onto `words`).

## Data flow

```
data/proficiency/ja.tsv           (surface → band; built by build-proficiency.py)
      │  joined BY SURFACE at ingest (scripts/ingest-jmdict.ts)
      ▼
jmdict_kanji.proficiency_band / jmdict_kana.proficiency_band   (server-only source)
      │  jmdict_lookup / wordnet_en_ja_lookup take the HEADWORD's band
      ▼  (edge function projects it, like frequency)
words.proficiency_band            (lazy verified cache; projection_version 5)
      │  repository.toWord
      ▼
Word.proficiencyBand → services/proficiency getProficiency(word)
      ▼
{ framework: "JLPT", band: 3, label: "N3" }   (or null)
```

## What's DONE (built + verified on local)

- **Wordlist** — `data/proficiency/ja.tsv`: **7,804 surfaces**, N5→1 … N1→5.
  Source = `jamsinclair/open-anki-jlpt-decks` (MIT, derived from Jonathan Waller's
  Tanos lists). **99.3% (7,753) match a JMdict headword.** Built by
  `scripts/build-proficiency.py <src-dir>` (strips parenthetical hints, splits
  alternate forms, keeps the easiest band on conflict). Attributed in
  `ATTRIBUTION.md`.
- **Schema** — `supabase/migrations/20260716_proficiency.sql`: adds
  `proficiency_band SMALLINT` to `words` (CHECK 1..6) + `jmdict_kanji` + `jmdict_kana`.
- **SQL lookups** — the migration DROP+CREATEs (return-type change) all five fns to
  return the headword's band: `jmdict_entry_headword`, `jmdict_lookup` (JA→EN + EN→JA),
  `wordnet_en_ja_lookup`, and the `_many` batch wrappers. Server-only EXECUTE
  (service_role) preserved.
- **Ingest** — `scripts/ingest-jmdict.ts` `loadProficiency()` + the join populate the
  source columns (future ingests do this automatically).
- **Edge projection** — `_lib.ts` (`ProviderResult.proficiencyBand`,
  `WordRowInsert.proficiency_band`, the projection push) + `index.ts` (RPC row types,
  `toWord`, `CURRENT_PROJECTION_VERSION` **4 → 5**).
- **Client read** — `Word.proficiencyBand` + `toWord` (`services/words/repository.ts`),
  `src/types/database.types.ts` (surgical add — see note below).
- **Registry + resolver** — `src/services/proficiency/`:
  - `framework.ts` — `ProficiencyFramework` type + `bandsFromLabels` + `labelForBand`.
  - `registry.ts` — `resolveFramework(lang)`: JA→JLPT (N5..N1), EN→CEFR (A1..C2), else null.
  - `index.ts` — `getProficiency(word)` → `{framework, band, label} | null`;
    `proficiencyFrameworkFor(lang)` for a future level picker.
- **Tests** — `tests/services/proficiency/proficiency.test.ts` (10): routing,
  ascending-is-harder, label mapping, null cases.
- **Seed** — re-dumped so the band persists across `db reset` + deploys (verified:
  学校→1/N5, 経済→2/N4, 形而上学→NULL).
- **Verified** — `jmdict_lookup` returns bands (学校/食べる/猫→N5, 経済→N4,
  EN→JA `school`→学校 N5); edge `_lib` tests pass; app typecheck + full suite green.

## Remaining

1. **UI badge (feature 1)** — nothing renders `getProficiency()` yet. Drop a small
   "N3"/"B2" badge into `ListRow`, the translate result head, the reader hovercard,
   and the flashcard face.
2. **Level-based new-words quiz (feature 2)** — **BUILT (needs live verify).** A new
   **Learn** tab (`views/LearnView.tsx`) with a band picker (from
   `proficiencyFrameworkFor(lang)`) → pulls N UNSEEN words at the chosen band and
   quizzes them through the existing `useTextQuiz` save+review loop (mode `learn`,
   so each grade adds the word + seeds SRS + refines the level, exactly like the
   reader's "Quiz N new words").
   - **Source retrieval** — `learn_words_at_band(source, target, band, user_id, limit)`
     (migration `20260717_learn_words.sql`, server-only EXECUTE) reads the JMdict
     source (the lazy `words` cache is incomplete), takes each entry's HEADWORD band
     (same pick as frequency), EXCLUDES entries already in the caller's `user_words`,
     collapses homograph writings, and orders by frequency DESC. JA→EN/JLPT only
     today (other pairs return nothing; the Learn tab shows "not available").
   - **Edge** — a `{ learn: { band, limit } }` mode in `translate/index.ts` selects
     the headwords then reuses `resolveBatch` to project them into `words` and return
     quiz cards (`Word[][]`). No paid MT (all headwords are JMdict-backed).
   - **Client** — `services/learn.ts` `fetchLearnWords`; `LearnView` reuses
     `TextQuizView`. Unit test `tests/services/learn.test.ts`; gated integration test
     for `learn_words_at_band` in `tests/integration/rpc.integration.test.ts`.
   - **Remaining:** live verify (migration apply + edge serve + drive the Learn tab —
     Supabase CLI/Deno weren't available in the build env); optional polish (a
     word-count / "learn more" picker, band styling, shuffling within a band).
   - **Calibration/placement quiz (feature 3, also #10) — BUILT (needs live verify).**
     A **"Find my level"** flow on the Learn tab (`CalibrationView` + `useCalibration`):
     a grid of 8 words at one band; the user taps the ones they DON'T know; an adaptive
     **binary search over the bands** (`advanceBandSearch`, pure + unit-tested in
     `tests/services/calibration.test.ts`) converges — in ~log₂(bands) rounds — on the
     hardest band known ≥ 80%. Result stored on TWO SEPARATE axes (never conflated):
     the JLPT band → `users.proficiency_band` (migration `20260718`; the "N3" the learner
     sees + the Learn default band), and `estimateLevel()` over the tested words'
     FREQUENCY → `users.level` (the DIFFICULTY axis the #12 embeddings/domain filter +
     `seedStability` consume — bands are too sparse to filter arbitrary neighbours). Words
     the user KNOWS (left unmarked) are added to ALL at full confidence via the
     non-clobbering cold-start seed (`initialStability=40` → confidence 5); unknown words
     are left alone and NO per-word reviews are recorded. Sources words from the SAME
     `learn_words_at_band` retrieval and passes `excludeSeen=true` (like the learn quiz)
     so already-added words don't re-appear on retake — an earlier `false` ("sample the
     whole band") re-showed them, which read as a bug. The "reveal meanings after a
     round" variant was deliberately NOT taken (speed) — see `DesignChoices.md` §15.
3. **Deploy** — the migration + wordlist land on prod/staging via a re-ingest
   (`npm run ingest:jmdict` now populates the band) OR loading the re-dumped seed.
   Until then prod/staging bands are NULL.
4. **Existing cached rows** stay band-NULL until re-translated (projection bumped to
   5; the active re-projection sweep is the deferred cache item — CLAUDE.md #3).
5. **English/CEFR data** — the registry maps EN→CEFR, but there is no
   `data/proficiency/en.tsv` yet (needs an openly-licensed CEFR wordlist, e.g. the
   CEFR-J list for the JA-native-learning-English market). JLPT (JA) is the only
   populated framework today. **Which list to use is now settled: CEFR-J** (free for
   commercial use w/ citation; the others — Oxford, Cambridge EVP, Kelly — are legally
   unusable) — see [`docs/research/CEFR_Licensing_And_Quality.md`](research/CEFR_Licensing_And_Quality.md)
   for the licensing/quality analysis and the **English attachment-point gap** (the
   JMdict ingest join covers Japanese surfaces only, so English CEFR bands need a
   separate join in the edge projection).

## Adding another language's framework

1. Get an openly-licensed `surface → level` wordlist; add attribution.
2. Emit `data/proficiency/<lang>.tsv` (`<surface>\t<band>`, **easiest = 1**).
3. Add one entry to `src/services/proficiency/registry.ts` (`bandsFromLabels`
   listed easiest→hardest).
4. Re-ingest (the join is language-generic) and re-project.

No schema, no UI, no lookup-function changes.

## Note — stale generated types

`src/types/database.types.ts` is stale vs the live schema; a full `gen:types` also
surfaces a pre-existing masked bug at `userWords.ts:185`. The `proficiency_band`
field was therefore added **surgically** (just the `words` Row/Insert/Update). A
proper resync is a separate cleanup.
