-- =========================================================
-- DINO — core database schema (consolidated).
--
-- Separation of concerns:
--   * words      — GLOBAL dictionary cache: verified, system-owned senses,
--                  READ-ONLY to clients (only the `translate` edge function,
--                  via the service role, writes).
--   * user_words — each user's PERSONAL vocabulary: one row per word they have.
--                  It references a dictionary sense (`dictionary_word_id`),
--                  OVERRIDES it (`custom_translation`), or STANDS ALONE (a
--                  created word). Mastery/review state lives here.
--   * lists      — a user's sub-lists (folders). "ALL" is virtual: a user's
--                  vocabulary IS their user_words rows, so there is no ALL row.
--   * list_words — tags user_words into sub-lists. A word can be in many lists;
--                  deleting a user_words row cascades its tags away.
-- =========================================================
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

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_profile"
ON users FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "user_insert_own_profile"
ON users FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "user_update_own_profile"
ON users FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =========================
-- 2. LISTS (a user's sub-lists)
-- =========================
CREATE TABLE IF NOT EXISTS lists (
  list_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  list_name TEXT NOT NULL,
  UNIQUE (user_id, list_name)              -- no duplicate list names per user
);

ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_lists"
ON lists FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "user_manage_own_lists"
ON lists FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =========================
-- 3. WORDS (global dictionary cache — read-only to clients)
-- =========================
CREATE TABLE IF NOT EXISTS words (
  word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input TEXT NOT NULL,
  translation TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,  -- 'system' for global entries
  -- only block exact duplicates; one input may have multiple senses.
  UNIQUE (input, translation, source_lang, target_lang, created_by, is_verified)
);

CREATE INDEX IF NOT EXISTS idx_words_cache_search ON words (input, source_lang, is_verified);
CREATE INDEX IF NOT EXISTS idx_words_lang_pair ON words (source_lang, target_lang, input);

ALTER TABLE words ENABLE ROW LEVEL SECURITY;
-- Clients may only READ verified dictionary entries; every write is server-side
-- (edge function with the service role, which bypasses RLS). There are
-- deliberately NO client insert/update/delete policies.
CREATE POLICY "select_verified_words"
ON words FOR SELECT USING (is_verified = TRUE);

-- =========================
-- 4. USER_WORDS (a user's personal vocabulary + mastery)
-- =========================
CREATE TABLE IF NOT EXISTS user_words (
  user_word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  -- the global dictionary sense this came from (NULL = standalone/created)
  dictionary_word_id UUID REFERENCES words(word_id) ON DELETE SET NULL,
  -- the user's own meaning: set for created words AND edits/overrides;
  -- NULL means "use the referenced dictionary translation".
  custom_translation TEXT,
  -- mastery / spaced-repetition state
  confidence_rating INT NOT NULL DEFAULT 0 CHECK (confidence_rating BETWEEN 0 AND 5),
  last_reviewed_date TIMESTAMPTZ,                          -- NULL until first review
  originally_translated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- a standalone entry must carry its own meaning
  CONSTRAINT user_words_has_meaning
    CHECK (dictionary_word_id IS NOT NULL OR custom_translation IS NOT NULL)
);

-- One entry per (user, dictionary sense); one standalone per (user, input, pair, meaning).
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_words_dictionary
  ON user_words (user_id, dictionary_word_id)
  WHERE dictionary_word_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_words_custom
  ON user_words (user_id, input, source_lang, target_lang, custom_translation)
  WHERE dictionary_word_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_words_by_user ON user_words (user_id);
CREATE INDEX IF NOT EXISTS idx_user_words_lookup
  ON user_words (user_id, input, source_lang, target_lang);

ALTER TABLE user_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_manage_own_user_words"
ON user_words FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =========================
-- 5. LIST_WORDS (tags user_words into sub-lists)
-- =========================
CREATE TABLE IF NOT EXISTS list_words (
  list_word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
  user_word_id UUID NOT NULL REFERENCES user_words(user_word_id) ON DELETE CASCADE,
  UNIQUE (list_id, user_word_id)           -- no same word twice in one list
);
CREATE INDEX IF NOT EXISTS idx_list_words_lookup ON list_words (list_id, user_word_id);

ALTER TABLE list_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_list_words"
ON list_words FOR SELECT
USING (list_id IN (SELECT list_id FROM lists WHERE user_id = auth.uid()));
CREATE POLICY "user_manage_own_list_words"
ON list_words FOR ALL
USING (list_id IN (SELECT list_id FROM lists WHERE user_id = auth.uid()))
WITH CHECK (list_id IN (SELECT list_id FROM lists WHERE user_id = auth.uid()));
