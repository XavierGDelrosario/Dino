-- =========================================================
-- Admin panel: feature grants with expiry (docs/TODO.md §8). Per-user entitlement
-- grants (unlock voice/camera/llm, raise a quota) with an optional expiry.
--
-- HARD LEGAL RULE: a granted privilege can be EXTENDED but NEVER taken away (once a
-- user has PAID, removing a paid entitlement is not allowed). This is enforced by
-- the DATA MODEL, not by trusting admins: grants are APPEND-ONLY rows, and the
-- active entitlement for a feature is the UNION of its non-expired grants. To extend
-- you INSERT a new row with a later expiry; you can never shorten or delete an
-- existing grant, so inserting an earlier-expiring row can't revoke a longer one.
-- No UPDATE/DELETE is granted to anyone (incl. service_role).
-- =========================================================

CREATE TABLE IF NOT EXISTS feature_grants (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  feature    TEXT NOT NULL,            -- 'voice' | 'camera' | 'handwriting' | 'llm' | 'quota_boost' | …
  value      INT,                      -- optional magnitude (e.g. the boosted monthly_char_quota)
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,              -- NULL = permanent (no expiry)
  granted_by TEXT,                     -- admin user_id who issued it (audit)
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_feature_grants_user ON feature_grants (user_id);

-- RLS: a user may READ THEIR OWN grants (so the app can resolve entitlements);
-- nobody writes via PostgREST. Append-only — no UPDATE/DELETE for anyone.
ALTER TABLE feature_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feature_grants_select_own"
  ON feature_grants FOR SELECT USING (user_id = (auth.uid())::text);
REVOKE ALL ON feature_grants FROM anon, authenticated;
GRANT SELECT ON feature_grants TO anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON feature_grants FROM service_role;
GRANT INSERT, SELECT ON feature_grants TO service_role;

-- Issue a grant. SECURITY DEFINER + is_admin() gate; resolves the target by email
-- (what admins know) and stamps granted_by = the acting admin. INSERT-only, so it
-- can only ever ADD entitlement.
CREATE OR REPLACE FUNCTION admin_grant_feature(
  p_email      TEXT,
  p_feature    TEXT,
  p_value      INT         DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_note       TEXT        DEFAULT NULL
)
RETURNS feature_grants
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_row     feature_grants;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_feature), '') = '' THEN
    RAISE EXCEPTION 'feature is required' USING ERRCODE = '22023';
  END IF;

  SELECT user_id INTO v_user_id FROM users WHERE email = btrim(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no user with email %', p_email USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO feature_grants (user_id, feature, value, expires_at, granted_by, note)
  VALUES (v_user_id, btrim(p_feature), p_value, p_expires_at, (auth.uid())::text, p_note)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION admin_grant_feature(TEXT, TEXT, INT, TIMESTAMPTZ, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_grant_feature(TEXT, TEXT, INT, TIMESTAMPTZ, TEXT) TO anon, authenticated;

-- List grants for the admin UI (optionally filtered to one user's email), newest
-- first, with the target's email and a computed active flag (non-expired).
CREATE OR REPLACE FUNCTION admin_list_grants(p_email TEXT DEFAULT NULL)
RETURNS TABLE (
  id         BIGINT,
  email      TEXT,
  feature    TEXT,
  value      INT,
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  active     BOOLEAN,
  note       TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT g.id, u.email, g.feature, g.value, g.granted_at, g.expires_at,
           (g.expires_at IS NULL OR g.expires_at > now()) AS active,
           g.note
      FROM feature_grants g
      JOIN users u ON u.user_id = g.user_id
     WHERE p_email IS NULL OR u.email = btrim(p_email)
     ORDER BY g.granted_at DESC
     LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION admin_list_grants(TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_list_grants(TEXT) TO anon, authenticated;
