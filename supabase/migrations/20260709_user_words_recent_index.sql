-- =========================================================
-- Index the ALL-vocabulary paginated read (services/words/userWords.ts
-- getAllUserWords): WHERE user_id = ? ORDER BY originally_translated_date DESC,
-- user_word_id DESC, range(offset, …). The only existing index is
-- idx_user_words_by_user (user_id), so each page sorts the user's ENTIRE row set
-- and OFFSET re-scans from the top — O(total) per "load more" for a large
-- vocabulary. This composite (user_id, then the sort keys) turns it into an index
-- range scan, and also backs keyset pagination if we move off OFFSET later.
-- Forward-only, additive — safe to apply online.
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_user_words_user_recent
  ON user_words (user_id, originally_translated_date DESC, user_word_id DESC);
