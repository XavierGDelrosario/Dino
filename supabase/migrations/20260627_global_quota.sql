-- =========================================================
-- GLOBAL monthly MT spend cap (#1 cost protection).
--
-- The per-user monthly quota (consume_translation_quota) bounds ONE user, but the
-- real billing risk is the AGGREGATE: many users (or many anonymous guests) each
-- under their own quota can still sum to a large Google bill. This adds an app-level
-- GLOBAL ceiling across ALL users per calendar month, enforced server-side in the
-- edge function BEFORE the paid call (reserve-before-call, like the per-user one).
-- It complements — does not replace — the hosted billing console's hard caps.
--
-- Server-only: RLS on, no client policies/grants; only the edge (service role)
-- reserves against it. One row per UTC month; a new month is a new row (no reset).
-- =========================================================

CREATE TABLE IF NOT EXISTS global_translation_usage (
  period_month DATE   NOT NULL PRIMARY KEY,        -- first day of the month (UTC)
  chars_used   BIGINT NOT NULL DEFAULT 0,          -- BIGINT: the aggregate can be large
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE global_translation_usage ENABLE ROW LEVEL SECURITY;  -- no policies → clients can't read
GRANT SELECT, INSERT, UPDATE ON global_translation_usage TO service_role;

-- ATOMIC reserve of `p_chars` against the GLOBAL monthly cap (check + increment in
-- one call under a single global advisory lock — no check-then-meter race across
-- concurrent requests from different users). Mirrors consume_translation_quota but
-- keyed on the month only. Returns whether allowed + the month-to-date global total.
CREATE OR REPLACE FUNCTION consume_global_quota(
  p_chars INT,
  p_quota BIGINT
)
RETURNS TABLE (allowed BOOLEAN, used BIGINT)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_month   DATE   := date_trunc('month', (now() AT TIME ZONE 'UTC'))::date;
  v_chars   INT    := GREATEST(p_chars, 0);
  v_current BIGINT;
BEGIN
  -- One global lock (constant key) so the first-of-month insert can't race either.
  PERFORM pg_advisory_xact_lock(hashtext('global_translation_usage'));

  SELECT chars_used INTO v_current
    FROM global_translation_usage
   WHERE period_month = v_month;
  v_current := COALESCE(v_current, 0);

  IF v_current + v_chars > p_quota THEN
    allowed := FALSE; used := v_current; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO global_translation_usage (period_month, chars_used)
  VALUES (v_month, v_chars)
  ON CONFLICT (period_month) DO UPDATE
    SET chars_used = global_translation_usage.chars_used + v_chars,
        updated_at = now();

  allowed := TRUE; used := v_current + v_chars; RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION consume_global_quota(INT, BIGINT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION consume_global_quota(INT, BIGINT) TO service_role;
