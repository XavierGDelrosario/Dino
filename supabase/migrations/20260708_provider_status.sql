-- =========================================================
-- Admin panel: third-party API health (docs/TODO.md §8). Goal: nothing silently
-- lapses or caps out — surface each external provider's CREDENTIAL EXPIRY (with an
-- "expires in N days" warning) and current USAGE.
--
-- Scope note: most providers expose NO API for key/secret expiry (Google OAuth
-- client secret, SMTP key, Supabase access token), so expiry is tracked MANUALLY
-- here — that's the only reliable source. Live usage-vs-quota POLLING (Brevo account
-- API, Supabase billing) needs outbound calls with prod creds and is a follow-up;
-- the one usage signal we already own server-side — Google Translate MT characters —
-- is surfaced from global_translation_usage. Server-only table; admin-gated RPCs.
-- =========================================================

CREATE TABLE IF NOT EXISTS provider_status (
  provider              TEXT PRIMARY KEY,   -- 'google_translate' | 'google_oauth' | 'brevo' | 'supabase' | 'anthropic' | …
  credential_expires_at DATE,               -- when the key/secret/token expires (manually tracked)
  quota_note            TEXT,               -- free-form plan/limit reminder
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT
);

-- Server-only: RLS on, no client policies. Admin writes go through the definer RPC.
ALTER TABLE provider_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON provider_status FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON provider_status TO service_role;

-- Seed the providers currently in play so the panel renders with rows to fill in.
INSERT INTO provider_status (provider, quota_note) VALUES
  ('google_translate', 'Cloud Translation v2 — free tier 500k chars/mo'),
  ('google_oauth',     'OAuth client secret — rotate before expiry'),
  ('brevo',            'Transactional email — 300/day free tier'),
  ('supabase',         'Free tier — 500MB DB, then Pro')
ON CONFLICT (provider) DO NOTHING;

-- Upsert a provider's expiry / note. SECURITY DEFINER + is_admin() gate.
CREATE OR REPLACE FUNCTION admin_set_provider(
  p_provider   TEXT,
  p_expires_at DATE DEFAULT NULL,
  p_quota_note TEXT DEFAULT NULL
)
RETURNS provider_status
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row provider_status;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_provider), '') = '' THEN
    RAISE EXCEPTION 'provider is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO provider_status (provider, credential_expires_at, quota_note, updated_at, updated_by)
  VALUES (btrim(p_provider), p_expires_at, p_quota_note, now(), (auth.uid())::text)
  ON CONFLICT (provider) DO UPDATE
    SET credential_expires_at = EXCLUDED.credential_expires_at,
        quota_note            = EXCLUDED.quota_note,
        updated_at            = now(),
        updated_by            = (auth.uid())::text
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION admin_set_provider(TEXT, DATE, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_set_provider(TEXT, DATE, TEXT) TO anon, authenticated;

-- Provider health: expiry + days-to-expiry + the one usage signal we own (MT chars
-- this UTC month, for google_translate). Admin-gated.
CREATE OR REPLACE FUNCTION admin_provider_health()
RETURNS TABLE (
  provider              TEXT,
  credential_expires_at DATE,
  days_to_expiry        INT,
  quota_note            TEXT,
  mt_chars_used         BIGINT,   -- non-null only for google_translate
  updated_at            TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_month DATE := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT p.provider,
           p.credential_expires_at,
           CASE WHEN p.credential_expires_at IS NULL THEN NULL
                ELSE (p.credential_expires_at - CURRENT_DATE) END,
           p.quota_note,
           CASE WHEN p.provider = 'google_translate'
                THEN (SELECT g.chars_used FROM global_translation_usage g WHERE g.period_month = v_month)
                ELSE NULL END,
           p.updated_at
      FROM provider_status p
     ORDER BY p.provider;
END;
$$;
REVOKE ALL ON FUNCTION admin_provider_health() FROM public;
GRANT EXECUTE ON FUNCTION admin_provider_health() TO anon, authenticated;
