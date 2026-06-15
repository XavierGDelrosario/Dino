# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

DINO (大脳) is a vocabulary-learning app: a user inputs a word in a target language, it gets translated and saved to lists, and later reviewed via flashcards with spaced repetition. See `DinoPOC.md` for the full product brief, data model rationale, and risk notes.

The repo is **early scaffolding**. Only three files contain real logic — `supabase/migrations/20260613_init.sql`, `src/services/dictionary.ts`, and `src/services/lists.ts`. Every other file under `src/` (views, components, config clients, `main.tsx`, `App.tsx`, types) is an empty stub establishing the intended directory layout. There is **no `package.json`, build config, lint config, or test setup yet** — so there are no build/lint/test commands to run. When adding tooling, the code already commits to a stack: **React web (Vite-style `main.tsx` + `.tsx`) + TypeScript + Supabase + DeepL**.

> Note on stack drift: `DinoPOC.md` predates implementation and names React Native + Firebase + Google login. The committed code instead uses Supabase (Postgres + Auth + RLS) and a DeepL client. **The code is the source of truth**, not the POC doc.

## Data model (the big picture)

Five tables, defined in `supabase/migrations/20260613_init.sql`:

- `users` — `user_id` is the Supabase Auth UID (TEXT, not UUID).
- `lists` — a user's vocab folders. `UNIQUE (user_id, list_name)`.
- `words` — a **global translation cache** shared across users. Exact-duplicate translations are blocked by `UNIQUE (input, translation, source_lang, target_lang, created_by, is_verified)`, but the same input may have multiple meanings/rows.
- `list_words` — dumb junction table linking words into lists. Zero stats.
- `user_word_mastery` — per-user learning state (`confidence_rating` 1–5, `last_reviewed_date`, `next_review_date`) driving the flashcard/spaced-repetition engine. Exactly one row per `(user_id, word_id)`.

Cascade rule: deleting a list cascades to its `list_words` only — `words` and `user_word_mastery` are never touched, so a user's "universal brain" survives folder deletion.

## Two invariants that drive the service layer

These are non-obvious and must be preserved when extending `src/services/`:

1. **The "ALL" list.** Every user has an auto-created list named `"ALL"` containing every word they've ever added. `getOrCreateAllListId` (`src/services/lists.ts`) idempotently fetches-or-creates it. Both add-word paths in `dictionary.ts` link new words into the ALL list — `addCustomWordsBatchToAllOnly` links *only* there; `addCustomWordsBatchToList` links to both a target list *and* ALL. Anything that adds words must go through ALL.

2. **`is_verified` must never leak.** `words` is global, so an unverified/user-typed translation must not become the canonical definition for other users. The DB enforces this via RLS in the migration: clients can only `INSERT`/`UPDATE`/`DELETE` rows where `created_by = auth.uid() AND is_verified = FALSE`; `SELECT` returns verified rows plus the caller's own unverified rows. **Clients can never set `is_verified = TRUE`** — promotion to the global dictionary is a privileged/server-side operation. The service layer currently always inserts with `is_verified: false`. Any global look-up query must filter `is_verified = true`.

## Service-layer mechanics

`dictionary.ts`'s two batch functions follow the same ordered sequence (read it before modifying):
1. Resolve `allListId`.
2. Upsert `words` (onConflict on the full unique tuple), then re-map results back to inputs via a `input:::translation:::source:::target` key.
3. **Snapshot existing ALL-list links *before* inserting** — `isNewForUser` in the result is computed by diffing against this snapshot.
4. Upsert `user_word_mastery` rows (default confidence) for every word.
5. Upsert `list_words` links.

This corresponds to the "Find or Create" look-up rule and the cache-hit/cache-miss/API-fallback flow described in `DinoPOC.md`.

## Conventions

- DB columns are `snake_case`; TS domain types are `camelCase`. The service layer maps between them explicitly (see the `keyOf` / `wordByKey` mapping in `dictionary.ts`).
- Per the POC's IME notes, translation submit must be triggered by an explicit **button press, never the Enter key** (Japanese IME uses Enter to confirm kanji selection).
- Secrets go in `.env` (`.env.example` is the template; `.env` is gitignored). Supabase and DeepL clients read from env.
