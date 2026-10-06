-- =========================================================
-- Let a user write their own daily goals.
--
-- 20260704 revoked table-level INSERT/UPDATE on `users` from clients and re-granted
-- them PER COLUMN (so a client can never touch is_admin), which means every new
-- client-written column needs its own grant — the same step 20260718 took for
-- proficiency_band. 20260790 added the goal columns without it, so a guest's goal
-- write was refused with 42501 "permission denied for table users" (caught by the
-- staging smoke test; reads were already fine, SELECT is table-level). RLS
-- (own row only) still decides WHOSE row; this only says WHICH columns.
-- =========================================================

GRANT INSERT (daily_new_words_goal, daily_reviews_goal),
      UPDATE (daily_new_words_goal, daily_reviews_goal)
  ON users TO anon, authenticated;
