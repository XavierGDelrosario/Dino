-- =========================================================
-- DINO - Core Database Schema (Production Ready)
-- Place in: supabase/migrations/0001_init_dino_schema.sql
-- =========================================================
-- Enable extensions you might need (optional but common)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- =========================
-- 1. USERS
-- =========================
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,                 -- Supabase Auth UID
  email TEXT UNIQUE NOT NULL,
  date_created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- =========================
-- 2. LISTS
-- =========================
CREATE TABLE IF NOT EXISTS lists (
  list_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  list_name TEXT NOT NULL,
  UNIQUE (user_id, list_name)              -- no duplicate list names per user
);
-- =========================
-- 3. WORDS (Global Translation Cache)
-- =========================
CREATE TABLE IF NOT EXISTS words (
  word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input TEXT NOT NULL,
  translation TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  -- user who created this entry (NULL for global/system entries)
  created_by TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- only block exact duplicates, allow multiple meanings/translations for the same input word.
  UNIQUE (input, translation, source_lang, target_lang, created_by, is_verified)
);
-- =========================
-- 4. LIST_WORDS (Junction: lists <-> words)
-- =========================
CREATE TABLE IF NOT EXISTS list_words (
  list_word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
  word_id UUID NOT NULL REFERENCES words(word_id) ON DELETE CASCADE,
  UNIQUE (list_id, word_id)               -- no same word twice in one list
);
-- =========================
-- 5. USER_WORD_MASTERY
--    (Spaced Repetition / Flashcard Brain)
-- =========================
CREATE TABLE IF NOT EXISTS user_word_mastery (
  mastery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  word_id UUID NOT NULL REFERENCES words(word_id) ON DELETE CASCADE,
  -- 1-5 confidence score from last review
  confidence_rating INT NOT NULL DEFAULT 1 CHECK (confidence_rating BETWEEN 1 AND 5),
  -- when the word was last reviewed in a flashcard session
  last_reviewed_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- when the word was first translated / added to the user's universe
  originally_translated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_review_date TIMESTAMPTZ,
  UNIQUE (user_id, word_id)               -- one mastery row per user+word
);
-- =========================
-- PERFORMANCE INDEXES
-- =========================
-- For listing words in a list quickly
CREATE INDEX IF NOT EXISTS idx_list_words_lookup
  ON list_words (list_id, word_id);
-- For quickly fetching a user's mastery state for a set of words
CREATE INDEX IF NOT EXISTS idx_user_mastery_lookup
  ON user_word_mastery (user_id, word_id);
-- For spaced repetition queries (what is due next for this user?)
CREATE INDEX IF NOT EXISTS idx_user_mastery_next_review
  ON user_word_mastery (user_id, next_review_date);
-- For fast translation cache lookups
CREATE INDEX IF NOT EXISTS idx_words_cache_search
  ON words (input, source_lang, is_verified);
-- Helpful for language-pair browsing or analytics
CREATE INDEX IF NOT EXISTS idx_words_lang_pair
  ON words (source_lang, target_lang, input);
-- =========================
-- ROW LEVEL SECURITY (RLS) BASICS
-- Enable and define policies according to Supabase auth.uid()
-- =========================
-- WORDS: everyone can see verified entries; users see their own unverified ones
ALTER TABLE words ENABLE ROW LEVEL SECURITY;

-- SELECT: everyone sees verified, and their own unverified
CREATE POLICY "select_verified_or_own_words"
ON words
FOR SELECT
USING (
  is_verified = TRUE
  OR created_by = auth.uid()
);

-- INSERT: client can only insert unverified rows that belong to them
CREATE POLICY "insert_own_unverified_words"
ON words
FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND is_verified = FALSE
);

-- UPDATE: client can *never* set is_verified = TRUE or touch others' words
CREATE POLICY "update_own_unverified_words"
ON words
FOR UPDATE
USING (
  created_by = auth.uid()
  AND is_verified = FALSE
)
WITH CHECK (
  created_by = auth.uid()
  AND is_verified = FALSE
);

-- 4) DELETE: user can delete only their own unverified, non-system words.
--    Official / global ('system') words are never deleted via the client.
CREATE POLICY "words_delete_own_unverified"
ON words
FOR DELETE
USING (
  created_by = auth.uid()
  AND is_verified = FALSE
  AND created_by != 'system'
);

-- LISTS: user only sees / manages their own lists
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_lists"
ON lists
FOR SELECT
USING (user_id = auth.uid());
CREATE POLICY "user_manage_own_lists"
ON lists
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
-- LIST_WORDS: follow ownership via parent list
ALTER TABLE list_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_list_words"
ON list_words
FOR SELECT
USING (
  list_id IN (
    SELECT list_id FROM lists WHERE user_id = auth.uid()
  )
);
CREATE POLICY "user_manage_own_list_words"
ON list_words
FOR ALL
USING (
  list_id IN (
    SELECT list_id FROM lists WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  list_id IN (
    SELECT list_id FROM lists WHERE user_id = auth.uid()
  )
);
-- USER_WORD_MASTERY: each user only sees/manages their own mastery data
ALTER TABLE user_word_mastery ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_manage_own_mastery"
ON user_word_mastery
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());