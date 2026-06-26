-- =========================================================
-- Admin role + admin-gated read surface (docs/TODO.md §8 — Admin webpage).
--
-- A SERVER-ENFORCED admin role. `is_admin` lives on public.users, but clients can
-- NEVER write it: the own-row RLS UPDATE/INSERT policies only check
-- user_id = auth.uid(), so without a column lock a user could set is_admin = true
-- on their OWN row and self-promote. Column-level GRANTs remove is_admin from the
-- writable set; only the service role (bypasses GRANTs) and the DB owner can write
-- it. Admin-only reads cross ALL users (normal read-own RLS hides them), so they go
-- through SECURITY DEFINER RPCs that gate on is_admin() — never a client-side check.
--
-- This migration ships the role + the FIRST admin panel's data source (anonymized
-- usage overview). The destructive ops (the #3 re-projection sweep), feature-grant
-- writes, and the error-code log land later, each as its own admin-gated RPC.
-- =========================================================

-- 1. The role flag. Default false: every existing + future row is a normal user
--    until a privileged path (service role / SQL console) flips it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- 2. Lock JUST the is_admin column from clients. Replace the table-level
--    INSERT/UPDATE grants (which cover every column) with column-scoped grants over
--    every column EXCEPT is_admin, so a self-promotion write is rejected at the
--    privilege layer before RLS even runs, while every legitimate profile write
--    keeps working. NOTE: user_id/date_created ARE granted — PostgREST's upsert
--    (ensureUserProfile) emits `ON CONFLICT DO UPDATE SET user_id = excluded.user_id`,
--    setting the conflict key, so revoking UPDATE on it breaks the own-row upsert
--    with "permission denied for table users". RLS still forbids changing user_id to
--    another user's. MAINTENANCE: a NEW client-writable column on `users` must be
--    added to BOTH grants below (a column absent here is silently unwritable —
--    fails safe, but breaks the feature).
REVOKE UPDATE, INSERT ON users FROM anon, authenticated;
GRANT INSERT (user_id, email, date_created, native_language, learning_language, terms_agreed_at, terms_version, level)
  ON users TO anon, authenticated;
GRANT UPDATE (user_id, email, date_created, native_language, learning_language, terms_agreed_at, terms_version, level)
  ON users TO anon, authenticated;

-- 3. The admin predicate. SECURITY DEFINER so it reads users.is_admin regardless of
--    the caller's own-row RLS; STABLE (one value per statement). auth.uid() still
--    resolves to the CALLER inside a definer function (it reads the request JWT),
--    so this identifies who is asking, not the function owner. Anonymous / missing
--    caller → false.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE user_id = (auth.uid())::text AND is_admin
  );
$$;
REVOKE ALL ON FUNCTION is_admin() FROM public;
GRANT EXECUTE ON FUNCTION is_admin() TO anon, authenticated;

-- 4. First admin panel data source: anonymized MT-usage overview for a month
--    (defaults to the current UTC month, matching how usage is bucketed). SECURITY
--    DEFINER to read across ALL users' translation_usage (read-own RLS hides them);
--    gated on is_admin() so a normal caller gets an exception, not data. PII is
--    NEVER returned — each user is a stable opaque bucket (md5 prefix of the uid),
--    per the spec's "anonymized (no raw email/PII)" requirement.
CREATE OR REPLACE FUNCTION admin_usage_overview(p_month DATE DEFAULT NULL)
RETURNS TABLE (
  scope        TEXT,   -- 'global' | 'user'
  bucket       TEXT,   -- NULL for the global row; opaque user hash otherwise
  period_month DATE,
  chars_used   BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_month DATE := COALESCE(p_month, (date_trunc('month', now() AT TIME ZONE 'UTC'))::date);
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT 'global'::text, NULL::text, g.period_month, g.chars_used
      FROM global_translation_usage g
     WHERE g.period_month = v_month
    UNION ALL
    SELECT 'user'::text, left(md5(t.user_id), 12), t.period_month, t.chars_used::bigint
      FROM translation_usage t
     WHERE t.period_month = v_month
    ORDER BY 1, 4 DESC;  -- global row first, then users by spend desc
END;
$$;
REVOKE ALL ON FUNCTION admin_usage_overview(DATE) FROM public;
GRANT EXECUTE ON FUNCTION admin_usage_overview(DATE) TO anon, authenticated;
