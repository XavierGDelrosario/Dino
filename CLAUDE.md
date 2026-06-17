# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DINO (大脳) is a vocabulary-learning app (POC, Japanese ↔ English): translate words, save them to lists, later review via flashcards/spaced repetition. `DinoPOC.md` is the product brief and data-model rationale.

> Stack drift: `DinoPOC.md` predates code and says React Native + Firebase + DeepL. The actual stack is **Vite + React 18 + TypeScript + Supabase (Postgres/Auth/RLS) + a `translate` Edge Function**. The translation provider is **not finalized** (DeepL-shaped placeholder in the edge function). **Code is the source of truth.**

The service layer is built and **compiles/builds green** (`tsc` + `vite build`). The UI (`src/components`, `src/views`) is still empty stubs — services are the current surface.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit — needs no env or Supabase; the first gate to run
npm run build       # tsc && vite build
npm run dev         # Vite dev server; needs .env (throws at supabaseClient.ts otherwise)

npm test            # vitest run — service-layer unit tests (no env / Supabase needed)
npm run test:watch  # vitest in watch mode
npm run test:integration  # RLS spec vs a LIVE instance; fails without one (see tests/integration/)

cp .env.example .env   # then set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

# Edge function (Deno; the only place translation happens):
supabase functions serve translate     # local
supabase functions deploy translate     # deploy
# Edge secrets (server-side, NOT in .env): TRANSLATION_API_KEY
#   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically)
```

**Tests:** Vitest. Specs live under `tests/` mirroring `src/` (e.g. `tests/services/words/repository.test.ts`); shared helpers in `tests/support/` (a chainable Supabase-client stub, seed `Word` fixtures, and mock sense/translate providers). Imports use path aliases `@/*` → `src/*` and `@test/*` → `tests/support/*` (defined in both `vitest.config.ts` and `tsconfig.json`). Pure modules (`language/`, `concurrency`) are tested directly; orchestration services (`dictionary`, `lookup`, `customWords`) mock their dependency modules; leaf data modules (`lists`, `userWords`, `repository`, `session`) mock the Supabase client. The Deno `translate` edge function is **not** covered by this Node/Vitest suite (separate runtime, unimplemented provider) — its `toWord` / conflict-tuple logic mirrors the tested `repository.ts`. Node must be on PATH (installed at `/usr/local/bin/node`).

## Architecture — the big picture

**Translation is backend-only.** The frontend `translate()` (`services/translation/client.ts`) only `invoke`s the `translate` edge function. The provider API key and the actual call live **solely** in `supabase/functions/translate/index.ts`, which runs with the service role. The browser can never translate on its own, and **only that backend can write `is_verified = true`** (RLS forbids clients). Swapping providers = rewrite `callTranslationProvider` there; nothing else changes.

**`persist` flag** (on the translate request): individual **words are cached** as verified (`persist: true`, default); a **whole-paragraph contextual translation is display-only** (`persist: false`, never stored — we won't keep thousands of unique paragraphs).

**Translate ≠ save — two distinct flows:**
- `services/lookup.ts` (**READ**): `lookupWord` (returns *all* meanings of a word — the first may be wrong, user picks) and `translateParagraph` (whole-paragraph display translation + a `word → meanings` Map). Saves nothing to the user's lists.
- `services/dictionary.ts` (**WRITE / "quick add"**): `addWordToList` / `addWordsToList` translate and immediately save, accepting the preferred meaning.
- Saving a chosen word is **explicit**: `saveDictionaryWord` (`services/words/userWords.ts`) — it creates the user's `user_words` entry. Creating/editing a user's own word and deleting a word also live there.
- Rule of thumb: a function in `lookup.ts` never writes to a user's vocabulary; a verb-of-intent name (`lookup`/`translate`) whose body persists is a smell — split it.

**Auth = Supabase anonymous guest.** `session.ts ensureSession()` signs in anonymously (real `auth.uid()`, no login screen — the POC "guest profile") and ensures a `public.users` row. Every service is keyed on `userId`; RLS is keyed on `auth.uid()`.

## Data model

Tables in `supabase/migrations/20260613_init.sql` (one consolidated migration). The model **separates the global dictionary from each user's personal vocabulary**:
- `users` — `user_id` = Supabase Auth UID (TEXT). RLS: own row only.
- `lists` — a user's **sub-lists** (folders). `UNIQUE (user_id, list_name)`. "ALL" is **not** a stored list (see Invariants).
- `words` — **global dictionary cache**, verified + system-owned, **read-only to clients** (only the edge function writes). `UNIQUE (input, translation, source_lang, target_lang, is_verified)`; one input may have several sense rows. (No `created_by`: every row is system-created by construction, so it carried no information.)
- `user_words` — **a user's personal vocabulary**: one row per word they have. It references a dictionary sense (`dictionary_word_id`), **overrides** it (`custom_translation`), or **stands alone** (a created word: `custom_translation` set, no `dictionary_word_id`). Resolved meaning = `custom_translation ?? words.translation`. Mastery/review state (`confidence_rating 0–5`, `last_reviewed_date`, `originally_translated_date`) lives here.
- `list_words` — junction tagging `user_words` into sub-lists (`list_id ↔ user_word_id`).

Cascade: deleting a `user_words` row removes the word from **every sub-list** (`list_words` cascades) — it leaves the user's whole vocabulary, and re-adding later starts fresh at `confidence_rating = 0`. Deleting a sub-`list` drops only its `list_words` tags; the `user_words` rows survive. The global `words` row is never touched by client deletes.

## Invariants (preserve when extending `services/`)

1. **"ALL" is virtual.** A user's vocabulary *is* their `user_words` rows — there is no stored ALL list. "Every word is in ALL" is therefore **structural, not enforced in app code**. Sub-lists are optional tags; because `list_words` references a `user_words` row, a word can never be in a sub-list without being in the vocabulary. Deleting a word = deleting its `user_words` row (tags cascade). The name "ALL" stays reserved (a sub-list can't be created/renamed to it).
2. **The dictionary is server-write-only.** `words` holds only verified, system-owned senses. RLS lets clients **SELECT verified rows only** — clients cannot insert/update/delete `words` at all. Only the edge function (service role) writes verified entries. All user-authored content (created words, edits/overrides) lives in `user_words`, never in `words`.

## Module map (by responsibility)

- `config/supabaseClient.ts` — anon client singleton (throws if `VITE_SUPABASE_*` missing).
- `services/session.ts` — anonymous auth + `users` row + `getUserProfile`.
- `services/lists.ts` — sub-list CRUD (create/rename/delete/list). No ALL list; "ALL" stays a reserved name.
- `services/words/repository.ts` — **dictionary reads only**: the `words` (global cache) read API + DB-row ↔ domain `Word` (camelCase) mapping. Clients never write `words`.
- `services/words/userWords.ts` — **owns `user_words` + `list_words`**: the `UserWord` type/mapping and every personal-vocabulary operation — `saveDictionaryWord`, `createCustomWord`, `editUserWord` (override), `deleteUserWord`, `addUserWordToList`/`removeUserWordFromList` — plus the display reads (`getAllUserWords`, `getUserWordsInList`, `getUserWordStates`).
- `services/dictionary.ts` / `services/lookup.ts` — write / read translate flows (above).
- `services/language/` — registry (add a language = one entry in `registry.ts`), `detect.ts` (auto-detect + source resolution), `options.ts` (dropdown view-models), `tokenize.ts` (`Intl.Segmenter` word segmentation). Import via the barrel `./language`.
- `services/translation/` — the `invoke` wrapper + types (barrel `./translation`).
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
- **RLS / DB-constraint tests** — the default Vitest suite mocks the Supabase client, so it verifies app-side logic only, NOT database enforcement. The RLS spec is written in `tests/integration/rls.integration.test.ts` (two real users: cross-user `user_words`/`lists` isolation + that `words` is read-only to clients / no `is_verified = true` writes). It is **gated behind `RUN_INTEGRATION` and currently FAILS** until run against a live migrated instance — by design, so it stays out of the green unit gate. Run with `supabase start` + env, then `npm run test:integration` (instructions in the file's header). Still TODO there: `UNIQUE`/FK/cascade-constraint coverage. Note the default unit tests only assert *intent* (e.g. the client *sends* `is_verified: false`), not that the DB rejects violations.
- Before production: domain error types (services throw raw `PostgrestError`), tighten `CORS: *`, reconsider `supabaseClient` throwing at import (un-importable for tests).
