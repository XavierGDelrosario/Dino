-- =========================================================
-- User PROFICIENCY band — the placement quiz's result on its OWN axis.
--
-- The two level axes must NOT be conflated (CLAUDE.md / DesignChoices §3):
--   * users.level (INT 1..5)          = DIFFICULTY (frequency). Consumed by
--     seedStability + the #12 embeddings/domain filter, which compare it against
--     each word's frequency-difficulty (getDifficulty). Bands are too SPARSE
--     (~7.8k tagged surfaces) to filter arbitrary embedding neighbours, so that
--     path needs the dense frequency axis.
--   * users.proficiency_band (this)   = PROFICIENCY (JLPT/CEFR band). The "Find
--     my level" placement quiz's native output; drives the learner-facing level
--     label ("N3") + the Learn tab's default band.
--
-- Mirrors words.proficiency_band (SMALLINT, 1..6; JLPT uses 1..5, CEFR 1..6). The
-- placement quiz writes BOTH columns — the JLPT search result here, and an
-- estimateLevel() over the tested words' FREQUENCY into users.level — each on its
-- correct axis.
-- =========================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS proficiency_band SMALLINT
  CHECK (proficiency_band IS NULL OR proficiency_band BETWEEN 1 AND 6);

-- users has COLUMN-LEVEL write grants (20260704_admin.sql locks is_admin out of the
-- client-writable set). A new client-writable column is silently unwritable until
-- it's added to those grants. Grants are additive, so grant just this column (the
-- own-row RLS policy still authorizes the row). Own-row only, like `level`.
GRANT INSERT (proficiency_band), UPDATE (proficiency_band) ON users TO anon, authenticated;
