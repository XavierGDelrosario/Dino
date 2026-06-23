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
ON users FOR SELECT USING (user_id = (auth.uid())::text);
CREATE POLICY "user_insert_own_profile"
ON users FOR INSERT WITH CHECK (user_id = (auth.uid())::text);
CREATE POLICY "user_update_own_profile"
ON users FOR UPDATE USING (user_id = (auth.uid())::text) WITH CHECK (user_id = (auth.uid())::text);

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
ON lists FOR SELECT USING (user_id = (auth.uid())::text);
CREATE POLICY "user_manage_own_lists"
ON lists FOR ALL USING (user_id = (auth.uid())::text) WITH CHECK (user_id = (auth.uid())::text);

-- =========================
-- 3. WORDS (global dictionary cache — read-only to clients)
-- =========================
CREATE TABLE IF NOT EXISTS words (
  word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input TEXT NOT NULL,
  translation TEXT NOT NULL,
  -- Language is free-form TEXT (NOT an enum/FK) and part of every identity key
  -- below, so the model is language-agnostic: a new language (KO, ZH, ZH-Hant, …)
  -- is just new rows, and one surface form across pairs (愛 JA vs ZH) stays
  -- distinct. Convention: uppercase short codes. UTF-8 TEXT stores any script
  -- (Hangul, Hanzi) first-class. Japanese-specificity lives only in the jmdict_*
  -- SOURCE tables, never here. (Unvalidated by design — a `languages` registry +
  -- FK is the future tightening; see "Multi-language readiness" in CLAUDE.md.)
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  -- Pronunciation reading per side (kana furigana for JA, pinyin for ZH, …),
  -- NULL when a side needs none (e.g. the English side, or a phonetic script).
  -- Both populated only for two-logographic pairs like JA<->ZH. Filled by the
  -- edge function from the dictionary source (JMdict); deterministic given the
  -- term, so NOT part of the UNIQUE sense key.
  input_reading TEXT,
  translation_reading TEXT,
  -- Part-of-speech tags of the sense (JMdict POS codes: n, v5k, adj-i, …). An
  -- intrinsic, global attribute of the sense, projected from JMdict — distinct
  -- from the client-side kuromoji POS used only on the paragraph path, so saved
  -- single words carry POS too. NULL for non-JMdict (MT) rows.
  part_of_speech TEXT[],
  -- DIFFICULTY AXIS (corpus frequency; the level scale that needs no JLPT). Two
  -- nullable signals resolved by services/difficulty (getDifficulty): a curated
  -- override wins, else the frequency-derived level. Both are deterministic global
  -- attributes of the headword, so — like the readings above — NOT part of the
  -- UNIQUE sense key. (Relatedness is the OTHER, separate axis: a future
  -- word_embeddings table, deliberately NOT a column here.)
  --   * frequency — corpus-frequency SCORE (wordfreq Zipf × 100; HIGHER = more
  --     common; a normalized, cross-language-comparable measure). NULL for unranked
  --     / MT rows. Fixes ranking when a reading spans entries (いく→行く≫幾,
  --     eat→食べる≫食う). Sourced via data/frequency + the jmdict ingest join.
  frequency INT,
  --   * difficulty_override — a NORMALIZED 1..5 difficulty from a curated source
  --     (e.g. JLPT N5→1 … N1→5, HSK), overriding the frequency-derived level when
  --     present. NULL today (JMdict carries no JLPT); populated by a later ingest.
  difficulty_override INT CHECK (difficulty_override IS NULL OR difficulty_override BETWEEN 1 AND 5),
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  -- STABLE JMdict identity (NULL for non-JMdict rows, e.g. the MT fallback). The
  -- headword `input` is a PROJECTION OUTPUT that a logic change can move
  -- (いく→行く, uk/headword/ranking tweaks), so it is NOT a safe cache identity.
  -- These pin a row to its SOURCE sense so a re-projection can UPDATE it in place
  -- (preserving word_id, so user_words.dictionary_word_id references survive)
  -- instead of forking a stale duplicate. See the #1/#5 deferred items in CLAUDE.md.
  jmdict_entry_id  TEXT,    -- JMdict ent_seq of the source entry
  -- JA→EN: the entry's sense index (0 = primary); EN→JA: match rank. Both 0-based.
  jmdict_sense_pos INT CHECK (jmdict_sense_pos IS NULL OR jmdict_sense_pos >= 0),
  -- The direction-aware stable conflict key the edge function computes:
  --   JA→EN = '<entry_id>:<sense_pos>'  (headword-independent — fixes いく→行く)
  --   EN→JA = '<input>:<entry_id>'      (search term + matched entry; rank-independent)
  -- One precomputed string (not a column tuple) because the two directions
  -- disagree on whether `input` is identity: it's the UNSTABLE headword for
  -- JA→EN but the STABLE search term for EN→JA. A single string lets ONE
  -- non-partial UNIQUE serve both — and PostgREST can't infer a PARTIAL index for
  -- ON CONFLICT (Postgres 42P10), so a partial key keyed on "JMdict rows only"
  -- would be unusable as an upsert target.
  dictionary_ref   TEXT,
  -- Which projection produced this row — bumped (via the edge function's
  -- CURRENT_PROJECTION_VERSION) whenever the SOURCE data (a JMdict re-ingest) or
  -- the PROJECTION logic (jmdict_lookup / edge toWord — readings, headword, uk,
  -- ranking, dictionary_ref) changes. A row whose version < current is STALE; the
  -- (deferred, #5) active re-projection sweep rebuilds those keyed on the stable
  -- dictionary_ref. DEFAULT 1 = the pre-#1 baseline (no dictionary_ref), so every
  -- pre-existing row reads as stale — over-marking is safe (a needless re-project
  -- is idempotent), under-marking would silently skip a row that needs rebuilding.
  projection_version INT NOT NULL DEFAULT 1,
  -- The STABLE-identity key AND the edge function's only upsert onConflict target.
  -- Full (non-partial) UNIQUE — NULL `dictionary_ref` rows (non-JMdict) stay
  -- multi-allowed via NULL-distinctness, same trick as uq_user_words_dictionary.
  -- (The legacy UNIQUE (input, translation, source_lang, target_lang, is_verified)
  -- was DROPPED: dictionary_ref is the real identity, and the old key could only
  -- spuriously collide — two distinct JMdict entries sharing an identical writing
  -- AND gloss would have failed the projection upsert. All rows are system-created
  -- by the edge function; is_verified stays the RLS/cache gate.)
  UNIQUE (dictionary_ref, source_lang, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_words_cache_search ON words (input, source_lang, is_verified);
CREATE INDEX IF NOT EXISTS idx_words_lang_pair ON words (source_lang, target_lang, input);
-- The cache read matches input OR input_reading (a kana search → kanji-headword
-- rows), so index the reading side too — otherwise that OR-branch is a seq scan.
CREATE INDEX IF NOT EXISTS idx_words_reading_search
  ON words (input_reading, source_lang, target_lang)
  WHERE input_reading IS NOT NULL;

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
  -- mastery / spaced-repetition state. The scheduler is a continuous forgetting
  -- curve, not an interval schedule: `stability` is the memory strength (in
  -- DAYS) and recall probability at any moment is R(t) = exp(-Δdays / stability)
  -- (Ebbinghaus / Duolingo-HLR shape). The "review queue" is the vocabulary
  -- ranked by current R ascending (least confident first) — there is NO stored
  -- next-review date (a due date is only one projection of this curve; see
  -- services/review.ts + record_review() below). `confidence_rating` (0–5) is a
  -- DERIVED display bucket of `stability`, written by record_review().
  stability REAL,                                         -- NULL until first review
  confidence_rating INT NOT NULL DEFAULT 0 CHECK (confidence_rating BETWEEN 0 AND 5),
  last_reviewed_date TIMESTAMPTZ,                          -- NULL until first review
  originally_translated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- a standalone entry must carry its own meaning
  CONSTRAINT user_words_has_meaning
    CHECK (dictionary_word_id IS NOT NULL OR custom_translation IS NOT NULL)
);

-- One entry per (user, dictionary sense); one standalone per (user, input, pair, meaning).
-- This MUST be a full (non-partial) UNIQUE constraint, not a partial index: the
-- save path upserts with ON CONFLICT (user_id, dictionary_word_id), and Postgres
-- cannot infer a PARTIAL index for ON CONFLICT (error 42P10). A full unique key
-- is equivalent here — standalone created words have dictionary_word_id = NULL,
-- and NULLs are distinct in a unique key, so they stay multi-allowed exactly as
-- the old `WHERE dictionary_word_id IS NOT NULL` partial intended.
ALTER TABLE user_words
  ADD CONSTRAINT uq_user_words_dictionary UNIQUE (user_id, dictionary_word_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_words_custom
  ON user_words (user_id, input, source_lang, target_lang, custom_translation)
  WHERE dictionary_word_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_words_by_user ON user_words (user_id);
CREATE INDEX IF NOT EXISTS idx_user_words_lookup
  ON user_words (user_id, input, source_lang, target_lang);

ALTER TABLE user_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_manage_own_user_words"
ON user_words FOR ALL USING (user_id = (auth.uid())::text) WITH CHECK (user_id = (auth.uid())::text);

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
USING (list_id IN (SELECT list_id FROM lists WHERE user_id = (auth.uid())::text));
-- WRITE requires BOTH sides to be the caller's: the LIST (where it's filed) AND
-- the USER_WORD (what's filed). The list check alone left a gap — the FK to
-- user_words is satisfied by ANY existing word, so a caller who knew another
-- user's user_word_id could file it into their own list. (No read leak — a join
-- back to user_words still hides the foreign row via RLS — but it's a referential
-- hole.) USING stays list-only so a user can always REMOVE a tag from their list
-- (e.g. cleaning up a pre-fix bad row); WITH CHECK is what gates creation.
CREATE POLICY "user_manage_own_list_words"
ON list_words FOR ALL
USING (list_id IN (SELECT list_id FROM lists WHERE user_id = (auth.uid())::text))
WITH CHECK (
  list_id IN (SELECT list_id FROM lists WHERE user_id = (auth.uid())::text)
  AND user_word_id IN (SELECT user_word_id FROM user_words WHERE user_id = (auth.uid())::text)
);

-- =========================
-- 5b. ATOMIC SAVE-AND-TAG (save_dictionary_word / create_custom_word)
--
-- A save is two writes — create the user_words entry, then (optionally) tag it
-- into a sub-list. Doing them as two separate client round-trips is NON-ATOMIC:
-- if the tag write fails after the entry committed, the word lands in the
-- vocabulary (virtual ALL) but never in the chosen sub-list. These functions do
-- both in ONE transaction so it's all-or-nothing.
--
-- SECURITY INVOKER (default): every INSERT runs under the caller's RLS, so the
-- WITH CHECK (user_id = auth.uid()) on user_words and the list-ownership check on
-- list_words still apply — a foreign p_user_id or someone else's p_list_id is
-- simply rejected. p_user_id is passed (services are keyed on userId) but RLS,
-- not the param, is what authorizes the write.
-- =========================

-- save_dictionary_word: save a verified dictionary sense into the user's
-- vocabulary (+ optional sub-list tag). Idempotent per (user, sense): re-saving
-- is a no-op re-add that returns the existing row. input/langs are derived from
-- the referenced `words` row (single source of truth), not passed in.
CREATE OR REPLACE FUNCTION save_dictionary_word(
  p_user_id            TEXT,
  p_dictionary_word_id UUID,
  p_list_id            UUID DEFAULT NULL
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  d     words;       -- the referenced dictionary sense
  v_row user_words;
BEGIN
  -- RLS lets the caller SELECT verified `words`; an invalid id is NOT FOUND.
  SELECT * INTO d FROM words
   WHERE word_id = p_dictionary_word_id AND is_verified = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dictionary word % not found', p_dictionary_word_id;
  END IF;

  INSERT INTO user_words
    (user_id, input, source_lang, target_lang, dictionary_word_id, custom_translation)
  VALUES
    (p_user_id, d.input, d.source_lang, d.target_lang, p_dictionary_word_id, NULL)
  ON CONFLICT (user_id, dictionary_word_id) DO UPDATE
    SET input = EXCLUDED.input      -- no-op-ish; lets RETURNING surface the existing row
  RETURNING * INTO v_row;

  IF p_list_id IS NOT NULL THEN
    INSERT INTO list_words (list_id, user_word_id)
    VALUES (p_list_id, v_row.user_word_id)
    ON CONFLICT (list_id, user_word_id) DO NOTHING;
  END IF;

  RETURN v_row;
END;
$$;

-- create_custom_word: create the user's OWN standalone word (no dictionary
-- sense) (+ optional tag). Idempotent re-create: on the partial-unique violation
-- (uq_user_words_custom, which ON CONFLICT can't target — Postgres 42P10) we
-- catch and re-fetch, mirroring saveDictionaryWord's no-op re-add. The caller
-- (userWords.ts) NFC-normalizes + validates input/translation before this runs.
CREATE OR REPLACE FUNCTION create_custom_word(
  p_user_id     TEXT,
  p_input       TEXT,
  p_translation TEXT,
  p_source      TEXT,
  p_target      TEXT,
  p_list_id     UUID DEFAULT NULL
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_row user_words;
BEGIN
  BEGIN
    INSERT INTO user_words
      (user_id, input, source_lang, target_lang, dictionary_word_id, custom_translation)
    VALUES
      (p_user_id, p_input, p_source, p_target, NULL, p_translation)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row FROM user_words
     WHERE user_id = p_user_id
       AND input = p_input
       AND source_lang = p_source
       AND target_lang = p_target
       AND custom_translation = p_translation
       AND dictionary_word_id IS NULL;
  END;

  IF p_list_id IS NOT NULL THEN
    INSERT INTO list_words (list_id, user_word_id)
    VALUES (p_list_id, v_row.user_word_id)
    ON CONFLICT (list_id, user_word_id) DO NOTHING;
  END IF;

  RETURN v_row;
END;
$$;

-- save_dictionary_words: the BATCH form of save_dictionary_word — save many
-- verified senses in ONE transaction (+ optional tag of all of them), so the
-- "Add all" path is one round-trip instead of N. Idempotent per (user, sense)
-- like the single save (ON CONFLICT re-adds in place). An id that isn't a
-- verified `words` row is silently skipped (the SELECT just yields no row), so
-- one bad id can't fail the whole batch. SECURITY INVOKER: RLS authorizes every
-- write exactly as for the single save (the param is not the authority).
CREATE OR REPLACE FUNCTION save_dictionary_words(
  p_user_id             TEXT,
  p_dictionary_word_ids UUID[],
  p_list_id             UUID DEFAULT NULL
)
RETURNS SETOF user_words
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  RETURN QUERY
  WITH ins AS (
    INSERT INTO user_words
      (user_id, input, source_lang, target_lang, dictionary_word_id, custom_translation)
    SELECT p_user_id, w.input, w.source_lang, w.target_lang, w.word_id, NULL
      FROM words w
     WHERE w.word_id = ANY(p_dictionary_word_ids)
       AND w.is_verified = TRUE
    ON CONFLICT (user_id, dictionary_word_id) DO UPDATE
      SET input = EXCLUDED.input      -- no-op-ish; surfaces the existing row in RETURNING
    RETURNING *
  ),
  -- Tag every inserted/existing row into the sub-list when one is given. A
  -- data-modifying CTE runs to completion even though the final SELECT ignores
  -- it, so the tags are written; the two-sided list_words RLS still applies.
  tagged AS (
    INSERT INTO list_words (list_id, user_word_id)
    SELECT p_list_id, ins.user_word_id FROM ins
     WHERE p_list_id IS NOT NULL
    ON CONFLICT (list_id, user_word_id) DO NOTHING
    RETURNING 1
  )
  SELECT ins.* FROM ins;
END;
$$;

REVOKE EXECUTE ON FUNCTION save_dictionary_word(TEXT, UUID, UUID)            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION save_dictionary_words(TEXT, UUID[], UUID)         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_custom_word(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION save_dictionary_word(TEXT, UUID, UUID)            TO anon, authenticated;
GRANT  EXECUTE ON FUNCTION save_dictionary_words(TEXT, UUID[], UUID)         TO anon, authenticated;
GRANT  EXECUTE ON FUNCTION create_custom_word(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO anon, authenticated;

-- =========================
-- 6. REVIEW_LOG (append-only review history) + record_review()
--
-- record_review() is the single, atomic, server-clocked writer for a review:
-- it stamps now(), updates `stability` from the grade (with the spacing
-- effect), derives the 0–5 confidence bucket, and appends a review_log row.
-- Doing the read-modify-write in ONE function avoids the race two clients would
-- hit doing it themselves, and keeps the scheduling math in one place so the
-- in-depth algorithm (FSRS) later is a new function body, not an API change.
-- review_log is kept because FSRS trains on review history — impossible to
-- backfill if not logged from the start. Deferred to that upgrade: a per-word
-- `difficulty` column, a power-law curve, and fitting the constants below.
-- =========================
CREATE TABLE IF NOT EXISTS review_log (
  log_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_word_id   UUID NOT NULL REFERENCES user_words(user_word_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  grade          SMALLINT NOT NULL CHECK (grade BETWEEN 1 AND 5),  -- 1 forgot … 5 easy
  reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  elapsed_days   REAL,           -- NULL on the first review (nothing elapsed yet)
  prev_stability REAL,           -- NULL on the first review
  new_stability  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_log_user_word
  ON review_log (user_word_id, reviewed_at);

ALTER TABLE review_log ENABLE ROW LEVEL SECURITY;
-- READ-ONLY to the owner. review_log is APPEND-ONLY and written ONLY by
-- record_review() (a SECURITY DEFINER function); there is intentionally NO client
-- INSERT (grant below is SELECT only), so the FSRS training history can't be
-- forged. A client therefore can't fabricate review rows for itself.
CREATE POLICY "user_select_own_review_log"
ON review_log FOR SELECT
USING (user_id = (auth.uid())::text);

-- record_review(user_word_id, grade) -> the updated user_words row.
-- grade is a 1–5 self-rated recall confidence (1 = forgot … 5 = easy); there is
-- no separate "again" — a forgotten card is just grade 1 (our model has no
-- intra-session requeue, only retrievability ranking).
-- SECURITY DEFINER (runs as owner, bypassing RLS) so it can write the otherwise
-- client-unwritable review_log — but it EXPLICITLY scopes every read/write to the
-- caller via `auth.uid()` (which is the request's JWT claim regardless of the
-- security context), so a foreign p_user_word_id is simply NOT FOUND. search_path
-- is pinned to defend the definer context.
CREATE OR REPLACE FUNCTION record_review(
  p_user_word_id UUID,
  p_grade        INT
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w         user_words;
  v_now     TIMESTAMPTZ := now();
  v_elapsed REAL;            -- days since last review (NULL on first review)
  v_r       REAL;            -- retrievability at review time (NULL on first review)
  v_prev_s  REAL;
  v_new_s   REAL;
BEGIN
  IF p_grade < 1 OR p_grade > 5 THEN
    RAISE EXCEPTION 'invalid grade % (expected 1-5)', p_grade;
  END IF;

  -- Lock the caller's row. SECURITY DEFINER bypasses RLS, so scope ownership
  -- EXPLICITLY here (user_id = auth.uid()) — a foreign id is then NOT FOUND.
  SELECT * INTO w FROM user_words
   WHERE user_word_id = p_user_word_id
     AND user_id = (auth.uid())::text
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_word % not found', p_user_word_id;
  END IF;

  v_prev_s := w.stability;

  IF w.stability IS NULL OR w.last_reviewed_date IS NULL THEN
    -- First-ever review: seed initial strength from the confidence.
    v_elapsed := NULL;
    v_r       := NULL;
    v_new_s   := CASE p_grade
                   WHEN 1 THEN 0.4
                   WHEN 2 THEN 0.7
                   WHEN 3 THEN 1.5
                   WHEN 4 THEN 3.5
                   WHEN 5 THEN 7.0
                 END;
  ELSE
    v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.last_reviewed_date)) / 86400.0);
    -- R = exp(-Δ / S); mirrors retrievability() in services/review.ts.
    v_r := exp(- v_elapsed / GREATEST(w.stability, 0.01));

    IF p_grade <= 2 THEN
      -- Forgot / barely: lapse, harder (smaller factor) for the lower grade.
      v_new_s := GREATEST(0.5, w.stability * (CASE p_grade WHEN 1 THEN 0.3 ELSE 0.6 END));
    ELSE
      -- Recalled: grow strength. The (1 - R) factor is the SPACING EFFECT —
      -- recalling something you'd nearly forgotten (low R) earns far more than
      -- re-reviewing something still fresh (R≈1, almost no gain). Higher
      -- confidence grows it more.
      v_new_s := w.stability * (1 + (CASE p_grade
                                       WHEN 3 THEN 1.0
                                       WHEN 4 THEN 2.0
                                       WHEN 5 THEN 3.5
                                     END) * (1 - v_r));
    END IF;
  END IF;

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         -- derive the 0–5 display bucket from the new strength
         confidence_rating  = CASE
                                WHEN v_new_s <  1  THEN 0
                                WHEN v_new_s <  3  THEN 1
                                WHEN v_new_s <  7  THEN 2
                                WHEN v_new_s < 16  THEN 3
                                WHEN v_new_s < 35  THEN 4
                                ELSE 5
                              END
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  INSERT INTO review_log
    (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability)
  VALUES
    (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s);

  RETURN w;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_review(UUID, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION record_review(UUID, INT) TO anon, authenticated;

-- review_queue(user_id, limit, list_id?) -> the N least-confident cards.
-- Does the retrievability ranking + LIMIT in SQL so only `limit` rows cross the
-- wire, NOT the whole vocabulary (the old client-side rank fetched everything).
-- R = exp(-Δdays / stability), 0 for a never-reviewed word — MIRRORS
-- retrievability() in services/review.ts; keep the two in sync. Resolves the
-- shown meaning/readings by joining `words` exactly like userWords.toUserWord
-- (custom_translation wins; translation_reading suppressed on an override).
-- SECURITY INVOKER: user_words RLS limits rows to the caller (the p_user_id
-- filter is belt-and-suspenders); list scoping is an EXISTS over the caller's tag.
CREATE OR REPLACE FUNCTION review_queue(
  p_user_id TEXT,
  p_limit   INT,
  p_list_id UUID DEFAULT NULL
)
RETURNS TABLE (
  user_word_id               UUID,
  user_id                    TEXT,
  input                      TEXT,
  source_lang                TEXT,
  target_lang                TEXT,
  dictionary_word_id         UUID,
  custom_translation         TEXT,
  translation                TEXT,
  input_reading              TEXT,
  translation_reading        TEXT,
  stability                  REAL,
  confidence_rating          INT,
  last_reviewed_date         TIMESTAMPTZ,
  originally_translated_date TIMESTAMPTZ,
  retrievability             REAL
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    uw.user_word_id,
    uw.user_id,
    uw.input,
    uw.source_lang,
    uw.target_lang,
    uw.dictionary_word_id,
    uw.custom_translation,
    COALESCE(uw.custom_translation, w.translation, '')                          AS translation,
    w.input_reading                                                             AS input_reading,
    CASE WHEN uw.custom_translation IS NOT NULL THEN NULL ELSE w.translation_reading END
                                                                                AS translation_reading,
    uw.stability,
    uw.confidence_rating,
    uw.last_reviewed_date,
    uw.originally_translated_date,
    (CASE
       WHEN uw.stability IS NULL OR uw.stability <= 0 OR uw.last_reviewed_date IS NULL THEN 0
       ELSE exp( - GREATEST(0, EXTRACT(EPOCH FROM (now() - uw.last_reviewed_date)) / 86400.0)
                 / uw.stability )
     END)::REAL                                                                 AS retrievability
  FROM user_words uw
  LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
  WHERE uw.user_id = p_user_id
    AND (p_list_id IS NULL OR EXISTS (
          SELECT 1 FROM list_words lw
           WHERE lw.user_word_id = uw.user_word_id
             AND lw.list_id = p_list_id))
  -- least-confident first; ties broken by oldest review (nulls = never = oldest).
  ORDER BY retrievability ASC,
           COALESCE(uw.last_reviewed_date, 'epoch'::timestamptz) ASC
  LIMIT GREATEST(0, p_limit);
$$;

REVOKE EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID) TO anon, authenticated;

-- =========================
-- 7. TABLE PRIVILEGES for the API roles
-- RLS above restricts WHICH rows a role sees/writes; these GRANTs are what allow
-- the operation to be attempted at all. Supabase's current default does NOT
-- auto-expose new tables to anon/authenticated, so without these every request
-- fails with "permission denied for table ...". `words` stays server-write-only:
-- clients get SELECT only (the service role bypasses RLS for writes).
-- Grants here mirror each table's policies exactly.
-- =========================
GRANT SELECT, INSERT, UPDATE          ON users      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON lists      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON user_words TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON list_words TO anon, authenticated;
GRANT SELECT                          ON review_log TO anon, authenticated;  -- read-own only; writes go through record_review() (SECURITY DEFINER)
GRANT SELECT                          ON words      TO anon, authenticated;
