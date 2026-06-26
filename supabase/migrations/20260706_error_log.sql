-- =========================================================
-- Admin panel: error-code log (docs/TODO.md §8). An APPEND-ONLY audit of failures
-- (esp. on paid features) so they're traceable after the fact. The edge function
-- (service role) writes a row on each failure path; admins read via an is_admin()-
-- gated RPC with filters. No client access at all.
--
-- user_id is intentionally NOT a FK: the audit trail must survive a user deletion
-- (otherwise the cascade erases exactly the history you'd want to investigate).
-- =========================================================

CREATE TABLE IF NOT EXISTS error_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code  TEXT NOT NULL,   -- app/SQLSTATE/HTTP-ish classification
  source      TEXT,            -- where it fired, e.g. 'translate.single' / 'translate.batch'
  user_id     TEXT,            -- nullable (anon / no session); NOT a FK (survive deletion)
  input       TEXT,            -- the triggering input (caller truncates)
  detail      TEXT             -- optional server-side message
);

CREATE INDEX IF NOT EXISTS idx_error_log_occurred_at ON error_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_code        ON error_log (error_code);

-- Server-only: RLS on, NO client policies. The edge function writes with the
-- service role (bypasses RLS). Append-only — deny UPDATE/DELETE to everyone,
-- including service_role, so the audit record can't be rewritten or purged
-- (mirrors review_log / the privilege-hardening migration).
ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON error_log FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON error_log FROM service_role;
GRANT INSERT, SELECT ON error_log TO service_role;

-- Admin read with filters. SECURITY DEFINER to read the server-only table; gated
-- on is_admin(). Defaults: last 7 days, newest first, capped at 1000 rows.
CREATE OR REPLACE FUNCTION admin_error_log(
  p_since TIMESTAMPTZ DEFAULT (now() - interval '7 days'),
  p_code  TEXT        DEFAULT NULL,
  p_user  TEXT        DEFAULT NULL,
  p_limit INT         DEFAULT 200
)
RETURNS TABLE (
  id          BIGINT,
  occurred_at TIMESTAMPTZ,
  error_code  TEXT,
  source      TEXT,
  user_id     TEXT,
  input       TEXT,
  detail      TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT e.id, e.occurred_at, e.error_code, e.source, e.user_id, e.input, e.detail
      FROM error_log e
     WHERE e.occurred_at >= p_since
       AND (p_code IS NULL OR e.error_code = p_code)
       AND (p_user IS NULL OR e.user_id = p_user)
     ORDER BY e.occurred_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION admin_error_log(TIMESTAMPTZ, TEXT, TEXT, INT) FROM public;
GRANT EXECUTE ON FUNCTION admin_error_log(TIMESTAMPTZ, TEXT, TEXT, INT) TO anon, authenticated;
