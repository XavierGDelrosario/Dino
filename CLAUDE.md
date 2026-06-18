# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DINO (大脳) is a vocabulary-learning app (POC, Japanese ↔ English): translate words, save them to lists, later review via flashcards/spaced repetition. `DinoPOC.md` is the product brief and data-model rationale.

> Stack drift: `DinoPOC.md` predates code and says React Native + Firebase + DeepL. The actual stack is **Vite + React 18 + TypeScript + Supabase (Postgres/Auth/RLS) + a `translate` Edge Function**. The primary dictionary provider is **JMdict** (self-hosted, wired into the edge function); a machine-translation fallback for words JMdict lacks is **not finalized** (unimplemented stub). **Code is the source of truth.**

The service layer is built and **compiles/builds green** (`tsc` + `vite build`). The UI (`src/components`, `src/views`) is still empty stubs — services are the current surface.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit — needs no env or Supabase; the first gate to run
npm run build       # tsc && vite build
npm run dev         # Vite dev server; needs .env (throws at supabaseClient.ts otherwise)
# `predev`/`prebuild` auto-run `setup:dict`, copying kuromoji's ~12MB IPADIC
# dictionary from node_modules → public/dict (gitignored) so it's served at /dict/.

npm test            # vitest run — service-layer unit tests (no env / Supabase needed)
npm run test:watch  # vitest in watch mode
npm run test:integration  # RLS spec vs a LIVE instance; fails without one (see tests/integration/)

cp .env.example .env   # then set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

# Edge function (Deno; the only place translation happens):
supabase functions serve translate     # local
supabase functions deploy translate     # deploy
# Edge secrets (server-side, NOT in .env): TRANSLATION_API_KEY
#   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically)

# JMdict ingest (one-time, server-side ETL into the jmdict_* tables):
#   download a scriptin/jmdict-simplified `jmdict-eng-*.json` release, then:
npm run ingest:jmdict -- ./jmdict-eng-common-<ver>.json
#   Connects to local Postgres (port 54322) by default; override with DATABASE_URL.
#   See scripts/ingest-jmdict.ts. NEVER touches words/user_words/lists.
```

**Tests:** Vitest. Specs live under `tests/` mirroring `src/` (e.g. `tests/services/words/repository.test.ts`); shared helpers in `tests/support/` (a chainable Supabase-client stub, seed `Word` fixtures, and mock sense/translate providers). Imports use path aliases `@/*` → `src/*` and `@test/*` → `tests/support/*` (defined in both `vitest.config.ts` and `tsconfig.json`). Pure modules (`language/`, `concurrency`) are tested directly; orchestration services (`dictionary`, `lookup`, `customWords`) mock their dependency modules; leaf data modules (`lists`, `userWords`, `repository`, `session`) mock the Supabase client. The Deno `translate` edge function and the Node `scripts/ingest-jmdict.ts` loader are **not** covered by this Node/Vitest suite (separate runtimes; the JMdict lookup + ingest run only there) — the edge function's `toWord` / conflict-tuple logic mirrors the tested `repository.ts`. Node must be on PATH (installed at `/usr/local/bin/node`).

## Architecture — the big picture

**Translation is backend-only.** The frontend `translate()` (`services/translation/client.ts`) only `invoke`s the `translate` edge function, which runs with the service role in `supabase/functions/translate/index.ts`. The browser can never translate on its own, and **only that backend can write `is_verified = true`** (RLS forbids clients). The **primary** provider is JMdict, queried server-side via the `jmdict_lookup` SQL function; `callTranslationProvider` is the (unimplemented) MT fallback for words JMdict lacks. Adding/swapping the MT provider happens there; nothing client-side changes.

**`persist` flag** (on the translate request): individual **words are cached** as verified (`persist: true`, default); a **whole-paragraph contextual translation is display-only** (`persist: false`, never stored — we won't keep thousands of unique paragraphs).

**Translation is backend-only, but morphological analysis is client-side.** Segmentation + readings/lemmas come from `services/language/analyze.ts` (`analyze()`), which routes Japanese to a lazily-loaded **kuromoji** engine (other languages → plain `Intl.Segmenter`, no reading/lemma). This runs in the browser because it feeds the ephemeral, display-only paragraph path — nothing analyzed is persisted. `analyze()` is the single swap point if it ever moves server-side. kuromoji readings are **best-effort** (statistical IPADIC; can misread ambiguous tokens) — distinct from the **authoritative** verified readings stored on `words`.

**Dictionary stack — JMdict vs `words` vs kuromoji (who answers what).** Three pieces, two reading "surfaces":
- **JMdict (`jmdict_*` tables)** — the authoritative SOURCE (full dataset, server-only). Holds writings, readings, senses, glosses. Queried ONLY by the edge function via `jmdict_lookup(input, source, target)`; clients can't touch it.
- **`words`** — the lazy verified CACHE the client reads. The edge function fills it from JMdict on a miss; each row carries its sense's reading inline (`input_reading`/`translation_reading`).
- **kuromoji** — a client-side morphological ENGINE (not data, not authoritative) for free text: segments space-less Japanese sentences and gives a best-effort reading + lemma per token.

Reading/furigana resolution depends on whether there's CONTEXT:
- **No context** (single-word lookup, flashcard): use the **`words` reading** — authoritative. kuromoji is unreliable on isolated fragments and is NOT used here.
- **With context** (sentence/paragraph, via `translateParagraph`): use **kuromoji** (context disambiguates homographs). It overrides a token's kuromoji reading with the `words` reading ONLY when **(a)** the surface IS the dictionary form (`token.text === lemma`, so a conjugated 行った keeps its surface reading いった, not the lemma's いく) **and (b)** the looked-up senses agree on a SINGLE reading (so a homograph like 辛い → からい/つらい defers to kuromoji's context). No extra query — it reuses the per-token `words` lookup done for meanings.

Translate flow (edge function), one word: **(1)** read all verified `words` senses → cache hit returns them (readings included), no JMdict query; **(2)** miss → `jmdict_lookup` returns meaning + reading together in one query, projected into `words`, returned as `words: Word[]` (`word` = primary); **(3)** MT fallback (unimplemented) only if JMdict has no match. Homographs that JMdict splits into separate entries (辛い→からい/つらい) become separate `words` rows with their own correct readings — never swapped.

**Translate ≠ save — two distinct flows:**
- `services/lookup.ts` (**READ**): `lookupWord` (returns *all* meanings of a word — the first may be wrong, user picks) and `translateParagraph` (whole-paragraph display translation + reading/lemma-enriched tokens via `analyze()` + a `word → meanings` Map; meanings are looked up by **lemma** so conjugations like 行った resolve via 行く, then re-keyed under the surface text). Saves nothing to the user's lists.
- `services/dictionary.ts` (**WRITE / "quick add"**): `addWordToList` / `addWordsToList` translate and immediately save, accepting the preferred meaning.
- Saving a chosen word is **explicit**: `saveDictionaryWord` (`services/words/userWords.ts`) — it creates the user's `user_words` entry. Creating/editing a user's own word and deleting a word also live there.
- Rule of thumb: a function in `lookup.ts` never writes to a user's vocabulary; a verb-of-intent name (`lookup`/`translate`) whose body persists is a smell — split it.

**Auth = Supabase anonymous guest.** `session.ts ensureSession()` signs in anonymously (real `auth.uid()`, no login screen — the POC "guest profile") and ensures a `public.users` row. Every service is keyed on `userId`; RLS is keyed on `auth.uid()`.

## Data model

Tables in `supabase/migrations/20260613_init.sql` (one consolidated migration). The model **separates the global dictionary from each user's personal vocabulary**:
- `users` — `user_id` = Supabase Auth UID (TEXT). RLS: own row only.
- `lists` — a user's **sub-lists** (folders). `UNIQUE (user_id, list_name)`. "ALL" is **not** a stored list (see Invariants).
- `words` — **global dictionary cache**, verified + system-owned, **read-only to clients** (only the edge function writes). `UNIQUE (input, translation, source_lang, target_lang, is_verified)`; one input may have several sense rows. `input_reading` / `translation_reading` (nullable) hold the pronunciation reading of whichever side is non-phonetic — kana furigana for JA, pinyin for ZH; one side populated for JA↔EN, both for JA↔ZH, NULL otherwise. They are deterministic attributes of the headword, so **not** part of the `UNIQUE` key. The edge function fills them from JMdict's kana when projecting a sense; they are the furigana source for the no-context surface (lookups/flashcards) and are NULL only for words JMdict lacks (or before the ingest is run). (No `created_by`: every row is system-created by construction.)
- `user_words` — **a user's personal vocabulary**: one row per word they have. It references a dictionary sense (`dictionary_word_id`), **overrides** it (`custom_translation`), or **stands alone** (a created word: `custom_translation` set, no `dictionary_word_id`). Resolved meaning = `custom_translation ?? words.translation`. Readings are **read-only dictionary attributes resolved by joining `words`** (never stored on `user_words`, no custom readings): the input reading always comes from the sense; the **translation reading is suppressed on override** (the shown term is then the user's own, which the dictionary reading doesn't annotate); standalone created words have none. Mastery/review state (`confidence_rating 0–5`, `last_reviewed_date`, `originally_translated_date`) lives here.
- `list_words` — junction tagging `user_words` into sub-lists (`list_id ↔ user_word_id`).

Cascade: deleting a `user_words` row removes the word from **every sub-list** (`list_words` cascades) — it leaves the user's whole vocabulary, and re-adding later starts fresh at `confidence_rating = 0`. Deleting a sub-`list` drops only its `list_words` tags; the `user_words` rows survive. The global `words` row is never touched by client deletes.

**JMdict source** (`supabase/migrations/20260618_jmdict.sql`): the authoritative dictionary is self-hosted in normalized `jmdict_entries` / `jmdict_kanji` / `jmdict_kana` / `jmdict_senses` / `jmdict_glosses` tables, loaded once by `scripts/ingest-jmdict.ts`. These are **server-only** (RLS on, no policies, no grants — only the edge function's service role reads them, via the `jmdict_lookup(input, source, target)` SQL function). `words` stays the **lazy verified cache**: on a miss the edge function calls `jmdict_lookup`, projects the matched senses into `words`, and returns them. **Readings ride inline on each `words` row** (`input_reading` / `translation_reading`) — that is the furigana source for the **no-context** surface (single-word lookups, flashcards), where kuromoji is unreliable in isolation. **Sentence/paragraph furigana uses client-side kuromoji** (context-aware); `translateParagraph` only overrides a token's kuromoji reading with the dictionary reading when the looked-up `words` senses agree on a **single** reading (unambiguous) — otherwise it trusts kuromoji's context. There is deliberately **no separate readings table** (it would only duplicate `words` readings and can't beat context). JMdict is owned by EDRDG (attribution required; UI notice deferred).

## Invariants (preserve when extending `services/`)

1. **"ALL" is virtual.** A user's vocabulary *is* their `user_words` rows — there is no stored ALL list. "Every word is in ALL" is therefore **structural, not enforced in app code**. Sub-lists are optional tags; because `list_words` references a `user_words` row, a word can never be in a sub-list without being in the vocabulary. Deleting a word = deleting its `user_words` row (tags cascade). The name "ALL" stays reserved (a sub-list can't be created/renamed to it).
2. **The dictionary is server-write-only.** `words` holds only verified, system-owned senses. RLS lets clients **SELECT verified rows only** — clients cannot insert/update/delete `words` at all. Only the edge function (service role) writes verified entries. All user-authored content (created words, edits/overrides) lives in `user_words`, never in `words`.

## Module map (by responsibility)

- `config/supabaseClient.ts` — anon client singleton (throws if `VITE_SUPABASE_*` missing).
- `services/session.ts` — anonymous auth + `users` row + `getUserProfile`.
- `services/lists.ts` — sub-list CRUD (create/rename/delete/list). No ALL list; "ALL" stays a reserved name.
- `services/words/repository.ts` — **dictionary reads only**: the `words` (global cache) read API + DB-row ↔ domain `Word` (camelCase) mapping, including `inputReading` / `translationReading`. Clients never write `words`.
- `services/words/userWords.ts` — **owns `user_words` + `list_words`**: the `UserWord` type/mapping and every personal-vocabulary operation — `saveDictionaryWord`, `createCustomWord`, `editUserWord` (override), `deleteUserWord`, `addUserWordToList`/`removeUserWordFromList` — plus the display reads (`getAllUserWords`, `getUserWordsInList`, `getUserWordStates`).
- `services/dictionary.ts` / `services/lookup.ts` — write / read translate flows (above). `translateParagraph` overrides a token's kuromoji reading with the reading already on the looked-up `words` sense ONLY when it's unambiguous (a single distinct reading); otherwise kuromoji's context-aware reading stands. No extra query — it reuses the per-token `words` lookup it already does for meanings.
- `services/senses/` — the `SenseProvider` seam: `resolveSenseProvider(source, target)` routes a pair to a dictionary. Registry stays **empty** — the dictionary decision now lives server-side (the edge function serves JMdict), so every pair uses `mtFallbackProvider`, which delegates to the edge function and surfaces its full multi-sense `words` array.
- `services/language/` — registry (add a language = one entry in `registry.ts`), `detect.ts` (auto-detect + source resolution), `options.ts` (dropdown view-models), `tokenize.ts` (`Intl.Segmenter` word segmentation), `analyze.ts` (`analyze` → tokens + readings/lemmas; lazily-loaded kuromoji for JA, segmentation-only otherwise — the morphological-engine swap point), `furigana.ts` (`furiganaFor` → per-side reading annotations). Import via the barrel `./language`.
- `services/translation/` — the `invoke` wrapper + types (barrel `./translation`); `TranslationResult` carries `word` (primary) + `words` (all senses).
- `scripts/ingest-jmdict.ts` — one-time Node/TS loader (direct `pg`, truncate-and-reload) for the `jmdict_*` tables.
- `src/lib/concurrency.ts` — `mapLimit`; caps concurrent translate calls at `MAX_TRANSLATION_CONCURRENCY` (used by both translate flows).

## Conventions

- **snake_case DB ↔ camelCase domain**; the repository maps explicitly (no DB rows leak upward).
- **NFC-normalize user input** at every boundary (`.trim().normalize("NFC")`) — cache-key correctness, esp. Japanese. Already done in both translate flows, `customWords`, and the edge function.
- **Param style:** single primitive arg → positional; multiple args → an options object.
- **Cross-runtime duplication:** the edge function hand-mirrors `repository.ts`'s `toWord` and the `onConflict` tuple (separate Deno runtime) — keep them in sync.
- IME: translation submit should be a **button press, never Enter** (Japanese IME uses Enter to confirm kanji).
- Secrets: frontend `VITE_*` in `.env` (anon key is public; RLS protects data). Edge secrets are server-side only.

## Known deferred items (POC-acceptable; TODOs in code)

- **Generated DB types** — no `Database` type yet; services use `.select<string, RowType>()` casts. Generate `src/types/database.types.ts` and use `createClient<Database>` so schema drift becomes a compile error. TODO in that file.
- **Transactional save** — `saveDictionaryWord` / `createCustomWord` (+ optional sub-list tag) do non-atomic writes; if useful, move the entry-create-plus-tag into a Postgres RPC. (The ALL invariant is now structural, so it no longer needs app enforcement.)
- **RLS / DB-constraint tests** — the default Vitest suite mocks the Supabase client, so it verifies app-side logic only, NOT database enforcement. The RLS spec is written in `tests/integration/rls.integration.test.ts` (two real users: cross-user `user_words`/`lists` isolation + that `words` is read-only to clients / no `is_verified = true` writes). It is **gated behind `RUN_INTEGRATION` and currently FAILS** until run against a live migrated instance — by design, so it stays out of the green unit gate. It now also asserts the `jmdict_*` source tables are unreadable by clients. Run with `supabase start` + env, then `npm run test:integration` (instructions in the file's header). Still TODO there: `UNIQUE`/FK/cascade-constraint coverage. Note the default unit tests only assert *intent* (e.g. the client *sends* `is_verified: false`), not that the DB rejects violations.
- **Dictionary source (JMdict) — WIRED (code-complete; needs ingest run).** Self-hosted full JMdict is the **primary** provider, queried server-side by the edge function via `jmdict_lookup()` (both JA→EN and EN→JA), which projects ALL matching senses into verified `words` rows (readings inline on each row). The edge function returns the full multi-sense set (`words: Word[]`, `word` = primary). **MT remains an unimplemented fallback** (`callTranslationProvider` returns null) for words JMdict lacks + whole-paragraph display translation — implement it there if needed. **To activate:** apply the migration and run `npm run ingest:jmdict -- <jmdict-eng-*.json>` (start with the `-common-` subset for the POC / free tier). Until ingested, lookups for JA↔EN return no result (MT is null). The Deno edge logic and the Node loader are **not** covered by the Vitest suite (separate runtimes) — verify manually (`supabase functions serve translate`) + via the RLS integration spec. Readings are stored kana for JA; romaji is intentionally not a feature. **Furigana model:** `words` readings serve the no-context surface (lookups/flashcards); kuromoji serves sentences (context-aware), overridden only by an *unambiguous* dictionary reading. **Deferred:** fuzzy EN→JA (trigram GIN index built but unused — exact gloss match only), per-sense reading selection in `jmdict_lookup` (readings are taken per the sense's OWN entry, so homographs that JMdict splits into separate entries — 辛い→からい/つらい — are already correct; the only gap is a SINGLE entry carrying multiple readings tied to specific senses via `applies_to_kana`, where the entry's preferred kana is used for all of them — rarer, never a cross-meaning swap), per-kanji ruby (below), EDRDG attribution in the UI.
- **Morphological analysis (kuromoji)** — DONE (client-side): `analyze()` routes JA to lazily-loaded kuromoji (segmentation + reading + lemma), and `translateParagraph` uses it (lemma-based lookup; reading-enriched tokens). Real-engine tests in `tests/services/language/analyze.test.ts`; the old `Intl.Segmenter` limitation is still documented in `tokenize.test.ts`. Dictionary served from `/dict/` (see `setup:dict`). **Remaining caveat:** kuromoji readings are best-effort — it mis-reads short/ambiguous fragments (in isolation: 行った→行う, 今→こん), so treat paragraph furigana as a hint, not authoritative. The verified `words` readings remain the source of truth for saved words.
- **Furigana mono-ruby alignment** (polish; **deferred to UI work** — group ruby is correct meanwhile) — `words` readings are whole-word, so furigana renders as group ruby (reading over the whole term). For per-kanji placement, the cheap first step is a **peel-matching-kana-from-both-ends heuristic** (`alignFurigana(surface, reading)`: strip leading/trailing kana that equals the reading, leaving the kanji core to take the remainder → 食べる ⇒ 食[た]べる). Safe (only coarsens, never misreads), needs no dataset, and works on BOTH JMdict words and kuromoji tokens — build it when rendering furigana in the UI. It can't split kanji compounds (学校→group); that needs the **JmdictFurigana** dataset (ingest alongside JMdict, no analyzer) for stored words, **kuroshiro** for free text.
- Before production: domain error types (services throw raw `PostgrestError`), tighten `CORS: *`, reconsider `supabaseClient` throwing at import (un-importable for tests).
