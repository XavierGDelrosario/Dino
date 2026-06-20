-- =========================================================
-- DINO — per-user RESTRICTIONS / entitlements (the limits subsystem).
--
-- A small, extensible store for what a user is allowed to do and how much. Today
-- it holds one limit — the max characters per paragraph translation, which keeps
-- us inside the Google Translate free tier — but it is shaped to GROW: each new
-- restriction (voice, camera, a monthly character quota, …) is a new nullable
-- column here + a field in services/entitlements.ts. A NULL column means "no
-- override → use the application default", so:
--   * the single guest today needs NO row at all (defaults apply), and
--   * granting/adjusting a user later is a service-role UPSERT of just the
--     columns that differ.
--
-- Keyed on user_id (= auth.uid()), so it covers ANONYMOUS guests and future
-- authenticated users with the same code — the guest→account upgrade keeps the
-- same uid, so any overrides carry over untouched.
--
-- SECURITY: a user may READ their own limits (so the UI can show/pre-enforce
-- them) but can NEVER write them — only the service role grants/relaxes a
-- restriction. A client therefore cannot raise its own cap. The edge function
-- (service role) reads the caller's row to enforce server-side.
-- =========================================================
CREATE TABLE IF NOT EXISTS user_limits (
  user_id              TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  -- max characters per paragraph translation; NULL = use the app default.
  paragraph_char_limit INT CHECK (paragraph_char_limit IS NULL OR paragraph_char_limit > 0),
  -- max characters TRANSLATED PER CALENDAR MONTH (the hard free-tier ceiling,
  -- enforced against translation_usage below); NULL = use the app default.
  monthly_char_quota   INT CHECK (monthly_char_quota IS NULL OR monthly_char_quota > 0),
  -- future restrictions land here as nullable columns, e.g.:
  --   voice_enabled  BOOLEAN,
  --   camera_enabled BOOLEAN,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_limits ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner; NO client write policy (a client cannot grant itself a
-- higher limit). The service role bypasses RLS to administer limits + enforce.
CREATE POLICY "user_select_own_limits"
ON user_limits FOR SELECT USING (user_id = (auth.uid())::text);

GRANT SELECT                          ON user_limits TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON user_limits TO service_role;

-- =========================================================
-- translation_usage: cumulative paid-MT characters per user per CALENDAR MONTH —
-- the running total the monthly quota is checked against. Written ONLY by the
-- edge function (service role) AFTER a successful Google call, via the atomic
-- add_translation_usage() below. A client may READ its own usage (to show
-- "X / quota used") but never write it (no faking/resetting). A new month is a
-- new row (no reset job needed); old rows are history.
-- =========================================================
CREATE TABLE IF NOT EXISTS translation_usage (
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  period_month DATE NOT NULL,                       -- first day of the month (UTC)
  chars_used   INT  NOT NULL DEFAULT 0 CHECK (chars_used >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_month)
);

ALTER TABLE translation_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_select_own_usage"
ON translation_usage FOR SELECT USING (user_id = (auth.uid())::text);

GRANT SELECT               ON translation_usage TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON translation_usage TO service_role;

-- ATOMICALLY reserve `p_chars` of this month's quota: if the post-increment
-- total would stay within `p_quota`, add it and return allowed=true; otherwise
-- add NOTHING and return allowed=false. This is the hard monthly gate — doing the
-- check-and-increment in ONE call under a per-user advisory lock closes the
-- check-then-meter RACE (two concurrent requests can't both pass a stale read and
-- overshoot). The edge function calls this BEFORE the paid provider call, so a
-- denied request costs nothing (a reserved-but-then-failed provider call may
-- slightly over-count — deliberately conservative for a cost ceiling).
--
-- Month bucket uses UTC explicitly (date_trunc on `now() AT TIME ZONE 'UTC'`) so
-- it never depends on the DB session timezone — it must match the edge/client
-- which compute the bucket in UTC. Service-role only.
CREATE OR REPLACE FUNCTION consume_translation_quota(
  p_user_id TEXT,
  p_chars   INT,
  p_quota   INT
)
RETURNS TABLE (allowed BOOLEAN, used INT)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_month   DATE := date_trunc('month', (now() AT TIME ZONE 'UTC'))::date;
  v_chars   INT  := GREATEST(p_chars, 0);
  v_current INT;
BEGIN
  -- Serialize per user so even the first-of-month insert can't race.
  PERFORM pg_advisory_xact_lock(hashtext('translation_usage:' || p_user_id));

  SELECT chars_used INTO v_current
    FROM translation_usage
   WHERE user_id = p_user_id AND period_month = v_month;
  v_current := COALESCE(v_current, 0);

  IF v_current + v_chars > p_quota THEN
    allowed := FALSE; used := v_current; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO translation_usage (user_id, period_month, chars_used)
  VALUES (p_user_id, v_month, v_chars)
  ON CONFLICT (user_id, period_month) DO UPDATE
    SET chars_used = translation_usage.chars_used + v_chars,
        updated_at = now();

  allowed := TRUE; used := v_current + v_chars; RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION consume_translation_quota(TEXT, INT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION consume_translation_quota(TEXT, INT, INT) TO service_role;
