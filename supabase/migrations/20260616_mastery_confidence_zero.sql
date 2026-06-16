-- =========================================================
-- Make confidence_rating 0-based.
--
-- 0 = "new / never studied" (spaced-repetition convention); 1-5 = studied
-- levels. This lets the app use confidence 0 as the single "new" signal and
-- drive the flashcard engine from the same field. Replaces the original
-- DEFAULT 1 / CHECK (1..5) defined in 20260613_init.sql.
-- =========================================================

ALTER TABLE user_word_mastery
  ALTER COLUMN confidence_rating SET DEFAULT 0;

ALTER TABLE user_word_mastery
  DROP CONSTRAINT IF EXISTS user_word_mastery_confidence_rating_check;

ALTER TABLE user_word_mastery
  ADD CONSTRAINT user_word_mastery_confidence_rating_check
  CHECK (confidence_rating BETWEEN 0 AND 5);
