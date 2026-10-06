-- =========================================================
-- Guest word cap 5,000 → 1,000.
--
-- 20260785 gave guests a lower ceiling than accounts because every visitor is minted a
-- guest with no captcha, and the sweep never deletes a guest who holds data. At 5,000
-- words (≈1.5 MB) a few hundred scripted guests could fill the 500 MB free tier; at
-- 1,000 it takes ~1,700. Decided 2026-10-06 as the cheaper alternative to enabling
-- CAPTCHA now (which would break guest sign-in in the iOS build).
--
-- Measured on prod before choosing: the largest guest holds 3 words. A real guest who
-- reaches 1,000 keeps every word by creating an account (same uid, 20,000 cap). The
-- trigger function is unchanged — only its arguments; lists stay at (500, 100).
-- =========================================================

DROP TRIGGER IF EXISTS trg_user_words_cap ON user_words;
CREATE TRIGGER trg_user_words_cap
BEFORE INSERT ON user_words
FOR EACH ROW EXECUTE FUNCTION user_rows_cap(20000, 1000);
