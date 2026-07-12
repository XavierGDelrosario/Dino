-- =========================================================
-- Reap EMPTY anonymous guests — the second half of the [MED] anti-sybil item
-- (2026-06-28 audit). The captcha (services/captcha.ts) stops the bot from minting
-- guests; this reclaims the ones already minted, plus the ordinary drift of every
-- visitor getting a real auth.users row at bootstrap whether or not they ever save
-- a word. Supabase's own anonymous-auth guidance suggests exactly this cleanup.
--
-- SAFETY IS THE WHOLE POINT HERE. Migration 20260714 added a BEFORE DELETE guard on
-- users/auth.users precisely because a one-line DELETE once wiped 25 prod guests, so
-- an automated deleter has to earn its keep. This one is bounded on every side:
--
--   * ANONYMOUS ONLY   — is_anonymous; a real account is never a candidate.
--   * EMPTY ONLY       — no user_words, no lists, no feature_grants, no user_limits.
--                        (review_log hangs off user_words, so "no words" implies no
--                        reviews.) There is, by construction, nothing to lose.
--   * OLD ONLY         — created AND last-seen before the cutoff (default 30 days).
--   * QUOTA-SAFE       — skips anyone with paid-MT usage in the CURRENT month, so a
--                        sweep can never hand back a fresh monthly char quota.
--   * BOUNDED          — deletes at most p_limit per run (default 500).
--   * AUDITED          — every removal lands in account_deletion_log first.
--   * DRY-RUN FIRST    — p_dry_run = true counts candidates and deletes NOTHING. Run
--                        that before ever scheduling this against real data.
--
-- It sets the guard's transaction-local override itself (like delete_account does),
-- which is safe because the candidate set above can only ever contain throwaway
-- guests — never an account with data behind it.
--
-- Cron/server only: EXECUTE is revoked from PUBLIC, so no client can call it.
--
--   SELECT prune_anonymous_guests(dry_run => true);           -- what WOULD go
--   SELECT prune_anonymous_guests();                          -- 30d, ≤500
--   SELECT prune_anonymous_guests(min_age => '90 days');      -- more conservative
-- =========================================================

CREATE OR REPLACE FUNCTION prune_anonymous_guests(
  min_age  INTERVAL DEFAULT INTERVAL '30 days',
  max_rows INT      DEFAULT 500,
  dry_run  BOOLEAN  DEFAULT false
) RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - min_age;
  -- The monthly meter buckets in UTC on both sides (edge + SQL) — match it exactly,
  -- or a sweep near a month boundary could free someone's spent quota.
  v_month  DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_ids    TEXT[];
  v_count  INT;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT au.id::text AS id
    FROM auth.users au
    WHERE au.is_anonymous IS TRUE
      AND au.created_at < v_cutoff
      AND coalesce(au.last_sign_in_at, au.created_at) < v_cutoff
      -- Nothing of the user's would be lost:
      AND NOT EXISTS (SELECT 1 FROM user_words uw WHERE uw.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM feature_grants fg WHERE fg.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM user_limits ul WHERE ul.user_id = au.id::text)
      -- …and no in-month MT spend, so deleting them can't reset a monthly quota.
      AND NOT EXISTS (
        SELECT 1 FROM translation_usage tu
        WHERE tu.user_id = au.id::text
          AND tu.period_month = v_month
          AND tu.chars_used > 0
      )
    ORDER BY au.created_at        -- oldest first, so a capped run makes steady progress
    LIMIT greatest(max_rows, 0)
  ) candidates;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  IF dry_run THEN
    RETURN array_length(v_ids, 1);
  END IF;

  -- Deliberate, transaction-local: satisfies the 20260714 deletion guard.
  PERFORM set_config('dino.allow_user_deletion', 'on', true);

  INSERT INTO account_deletion_log (user_id) SELECT unnest(v_ids);

  -- Both halves: the public row (root of the per-user FK tree) and the login itself.
  -- auth.users has no FK from public.users (user_id is TEXT), so neither cascades to
  -- the other — dropping only one would leave an orphan.
  DELETE FROM public.users WHERE user_id = ANY(v_ids);
  DELETE FROM auth.users WHERE id::text = ANY(v_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

-- Server/cron only — never reachable from a client (defense in depth: the function is
-- SECURITY DEFINER and deletes users).
REVOKE ALL ON FUNCTION prune_anonymous_guests(INTERVAL, INT, BOOLEAN) FROM public;
REVOKE ALL ON FUNCTION prune_anonymous_guests(INTERVAL, INT, BOOLEAN) FROM anon, authenticated;

-- Weekly (guest bloat accrues slowly; a daily deleter buys nothing and fires more
-- often). Non-fatal where pg_cron isn't available — same pattern as the idempotency
-- prune (20260712); schedule it via Supabase Cron there instead.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  -- cron.schedule(jobname, …) is upsert-by-name in pg_cron ≥ 1.4.
  PERFORM cron.schedule('prune-anonymous-guests', '23 4 * * 0',
                        'SELECT public.prune_anonymous_guests()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule prune_anonymous_guests() manually / via Supabase Cron', SQLERRM;
END $$;
