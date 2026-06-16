-- =========================================================
-- Row Level Security for the users table.
--
-- The initial schema enabled RLS on words/lists/list_words/user_word_mastery
-- but NOT on users, leaving it open. A user may only see and manage their own
-- profile row (user_id must equal their auth.uid()).
-- =========================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_select_own_profile"
ON users
FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "user_insert_own_profile"
ON users
FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_update_own_profile"
ON users
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
