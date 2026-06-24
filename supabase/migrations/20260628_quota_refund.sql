-- =========================================================
-- Quota REFUND (compensating decrement) for the reserve-before-call model.
--
-- The edge reserves chars BEFORE the paid Google call (no check-then-meter race).
-- If the call ultimately spends nothing — Google returns null on a non-2xx /
-- network error / empty payload — those reserved chars would otherwise stay
-- consumed forever. These refund them, floored at 0, under the SAME advisory locks
-- as the reserves so a refund can't race a concurrent reserve. Server-role only.
-- =========================================================

CREATE OR REPLACE FUNCTION refund_translation_quota(p_user_id TEXT, p_chars INT)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_month DATE := date_trunc('month', (now() AT TIME ZONE 'UTC'))::date;
  v_chars INT  := GREATEST(p_chars, 0);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('translation_usage:' || p_user_id));
  UPDATE translation_usage
     SET chars_used = GREATEST(0, chars_used - v_chars), updated_at = now()
   WHERE user_id = p_user_id AND period_month = v_month;
END;
$$;

CREATE OR REPLACE FUNCTION refund_global_quota(p_chars INT)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_month DATE := date_trunc('month', (now() AT TIME ZONE 'UTC'))::date;
  v_chars INT  := GREATEST(p_chars, 0);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('global_translation_usage'));
  UPDATE global_translation_usage
     SET chars_used = GREATEST(0, chars_used - v_chars), updated_at = now()
   WHERE period_month = v_month;
END;
$$;

REVOKE EXECUTE ON FUNCTION refund_translation_quota(TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION refund_translation_quota(TEXT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION refund_global_quota(INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION refund_global_quota(INT) TO service_role;
