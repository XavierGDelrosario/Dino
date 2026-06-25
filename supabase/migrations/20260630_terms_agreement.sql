-- =========================================================
-- Terms-of-Service / Privacy acceptance, recorded PER ACCOUNT (#13 / §10 legal).
-- The signup flow requires ticking "I agree to the Terms & Privacy"; we stamp WHEN
-- they agreed and to WHICH version, so that if the Terms are updated later we can
-- detect accounts whose `terms_version` is behind the current one and re-prompt.
--   terms_agreed_at — timestamp of the last acceptance (NULL = never agreed, e.g.
--                     a guest who hasn't created an account).
--   terms_version   — the Terms version string that was accepted (see
--                     src/lib/terms.ts CURRENT_TERMS_VERSION).
-- Both nullable; live on `users`, so existing own-row RLS covers read/write.
-- =========================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version   TEXT;
