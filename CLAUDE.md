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

cp .env.example .env   # then set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

# Edge function (Deno; the only place translation happens):
supabase functions serve translate     # local
supabase functions deploy translate     # deploy
# Edge secrets (server-side, NOT in .env): TRANSLATION_API_KEY, SYSTEM_USER_ID
#   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically)
```

No test setup yet. Node must be on PATH (installed at `/usr/local/bin/node`).

## Architecture — the big picture

**Translation is backend-only.** The frontend `translate()` (`services/translation/client.ts`) only `invoke`s the `translate` edge function. The provider API key and the actual call live **solely** in `supabase/functions/translate/index.ts`, which runs with the service role. The browser can never translate on its own, and **only that backend can write `is_verified = true`** (RLS forbids clients). Swapping providers = rewrite `callTranslationProvider` there; nothing else changes.

**`persist` flag** (on the translate request): individual **words are cached** as verified (`persist: true`, default); a **whole-paragraph contextual translation is display-only** (`persist: false`, never stored — we won't keep thousands of unique paragraphs).

**Translate ≠ save — two distinct flows:**
- `services/lookup.ts` (**READ**): `lookupWord` (returns *all* meanings of a word — the first may be wrong, user picks) and `translateParagraph` (whole-paragraph display translation + a `word → meanings` Map). Saves nothing to the user's lists.
- `services/dictionary.ts` (**WRITE / "quick add"**): `addWordToList` / `addWordsToList` translate and immediately save, accepting the preferred meaning.
- Saving a chosen word is **explicit**: `saveWordToUserLibrary` (`services/words/userLibrary.ts`).
- Rule of thumb: a function in `lookup.ts` never writes to a user's lists; a verb-of-intent name (`lookup`/`translate`) whose body persists is a smell — split it.

**Auth = Supabase anonymous guest.** `session.ts ensureSession()` signs in anonymously (real `auth.uid()`, no login screen — the POC "guest profile") and ensures a `public.users` row. Every service is keyed on `userId`; RLS is keyed on `auth.uid()`.

## Data model

Tables in `supabase/migrations/` (`20260613_init.sql` + `20260616_users_rls.sql`):
- `users` — `user_id` = Supabase Auth UID (TEXT). RLS: own row only.
- `lists` — vocab folders. `UNIQUE (user_id, list_name)`.
- `words` — **global translation cache** shared across users. `UNIQUE (input, translation, source_lang, target_lang, created_by, is_verified)`; same input may have multiple meaning rows.
- `list_words` — dumb junction (lists ↔ words), no stats.
- `user_word_mastery` — per-user `(confidence_rating 1–5, last/next_review_date)`, one row per `(user_id, word_id)`.

Cascade: deleting a list drops its `list_words` only — `words` and `user_word_mastery` survive (the user's "universal brain").

## Invariants (preserve when extending `services/`)

1. **The "ALL" list.** Every saved word lands in the user's auto-created `"ALL"` list (`getOrCreateAllListId`, `lists.ts`). `saveWordToUserLibrary` enforces this. `ALL` cannot be renamed/deleted/created-by-name.
2. **`is_verified` never leaks.** RLS lets clients write only their own `is_verified = FALSE` rows and `SELECT` verified + own-unverified. Clients can **never** set `is_verified = TRUE` — only the edge function (service role) promotes to the global dictionary. Global look-ups filter `is_verified = true`.

## Module map (by responsibility)

- `config/supabaseClient.ts` — anon client singleton (throws if `VITE_SUPABASE_*` missing).
- `services/session.ts` — anonymous auth + `users` row + `getUserProfile`.
- `services/lists.ts` — list CRUD + `getOrCreateAllListId` (ALL reserved).
- `services/words/repository.ts` — **only** file that touches the `words` table; owns DB-row ↔ domain `Word` (camelCase) mapping.
- `services/words/userLibrary.ts` — `list_words` + `user_word_mastery` writes (`saveWordToUserLibrary`, `removeWordFromList`).
- `services/words/customWords.ts` — manual add/edit of a user's own word.
- `services/words/queries.ts` — `getListWords` (words + mastery for display).
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
- **Transactional save** — `saveWordToUserLibrary` does 3 non-atomic writes and enforces the ALL invariant in app code; move to a Postgres RPC. TODO in `userLibrary.ts`.
- **Edge function prerequisite** — its verified-word writes use `created_by = SYSTEM_USER_ID`, which the `words` FK requires to exist; seed a `system` user row.
- Before production: domain error types (services throw raw `PostgrestError`), tighten `CORS: *`, reconsider `supabaseClient` throwing at import (un-importable for tests).
