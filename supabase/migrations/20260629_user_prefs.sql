-- =========================================================
-- User language PREFERENCES (#13 profile). Per-user, so they follow an account
-- across devices (the app-UI locale stays client-side in localStorage — it must
-- work before any session). All nullable → fall back to the app defaults.
--   native_language   — the user's native language; the DEFAULT translation OUTPUT
--                       (target) and the "explain in" side of study.
--   learning_language — the language being studied; the DEFAULT "I'm learning" +
--                       input side.
-- Free-form TEXT like source_lang/target_lang (no enum/FK; uppercase codes).
-- RLS is unchanged — these live on `users` (own-row read/write already).
-- =========================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS native_language   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS learning_language TEXT;
