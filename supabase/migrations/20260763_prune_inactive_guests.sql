-- =========================================================
-- prune_anonymous_guests v2 — sweep INACTIVE guests, not just EMPTY ones.
--
-- WHY THIS CHANGES. v1 (20260727) deleted an anonymous guest only when it held nothing
-- at all: no words, no lists, no grants, no limits. That left the opposite case open,
-- and it is the one with a real obligation attached — a guest who SAVED words and then
-- cleared their browser. Their vocabulary sat on our servers forever, and because a
-- guest has no email and no credential there was no way for them to reach it, identify
-- it as theirs, or ask for it to be deleted. Indefinite retention of user content with
-- no erasure route is the part of GDPR/APPI that actually bites, and it was the one gap
-- the privacy-policy audit could not paper over with wording.
--
-- So the rule is now INACTIVITY, not emptiness: an anonymous guest untouched for
-- `min_age` is deleted along with whatever it holds. Measured on prod 2026-08-12 before
-- shipping: 65 anonymous guests, 4 holding words, 16 inactive past 30 days, of which
-- 2 hold words — i.e. this deletes 2 guests' vocabulary on its first real run today,
-- and grows from there.
--
-- ‼️ THE DANGEROUS PART, AND WHY `last_sign_in_at` IS NOT THE TEST.
-- The obvious implementation ages on auth.users.last_sign_in_at. GoTrue sets that at
-- SIGN-IN; a returning guest is restored from a stored session by a refresh-token grant,
-- which is not obviously a sign-in. If it does not move that column, then a learner who
-- opens the app every day still looks "inactive" and this function deletes their
-- vocabulary. That is the worst bug this file could have.
--
-- It could not be settled from prod data: every guest holding words was a single-session
-- user (created = last_sign_in = newest word, same day), so nothing has ever exercised
-- the return path. UNKNOWN, not safe. Rather than bet a user's data on GoTrue's
-- behaviour, the cutoff is computed from PRODUCT ACTIVITY as well as auth timestamps —
-- the newest of: sign-in, auth row update, a word saved, a word reviewed, an article
-- starred. Any real use of the app keeps the account alive even if every auth timestamp
-- is stale, so the failure mode is "we keep a guest slightly too long", never "we delete
-- someone who is still studying".
--
-- KEPT FROM v1, deliberately:
--   * ANONYMOUS ONLY — a real account is never a candidate, whatever its age. Accounts
--     have an email, so they have a recovery path and a way to ask; guests do not.
--   * NO IN-MONTH MT SPEND — deleting a spender would reset their translation_usage and
--     hand back a fresh monthly quota. A cost guard, not a data guard, so it stays.
--   * feature_grants / user_limits — an admin deliberately provisioned this account;
--     sweeping it would silently undo an admin action.
--   * dry_run, max_rows, the 20260714 deletion-guard override, and the audit row.
--
-- The privacy policy must state the retention period this implements; they are one
-- change, not two.
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
    SELECT au.id::text AS id, au.created_at
    FROM auth.users au
    WHERE au.is_anonymous IS TRUE
      -- LAST SEEN = the newest evidence of life from ANY source (see the header: the
      -- auth timestamps alone are not trustworthy for a session-restore return visit).
      AND GREATEST(
            au.created_at,
            COALESCE(au.last_sign_in_at, au.created_at),
            COALESCE(au.updated_at,      au.created_at),
            COALESCE((SELECT max(uw.originally_translated_date)
                        FROM user_words uw WHERE uw.user_id = au.id::text), au.created_at),
            COALESCE((SELECT max(uw.last_reviewed_date)
                        FROM user_words uw WHERE uw.user_id = au.id::text), au.created_at),
            COALESCE((SELECT max(rl.reviewed_at)
                        FROM review_log rl
                        JOIN user_words uw2 ON uw2.user_word_id = rl.user_word_id
                       WHERE uw2.user_id = au.id::text), au.created_at),
            COALESCE((SELECT max(mf.created_at)
                        FROM media_favorites mf WHERE mf.user_id = au.id::text), au.created_at)
          ) < v_cutoff
      -- An admin deliberately provisioned this account — never sweep it.
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
-- SECURITY DEFINER and deletes users). Restated because CREATE OR REPLACE keeps the
-- existing ACL but a future DROP/CREATE would not — and on hosted Supabase a freshly
-- created function re-acquires anon/authenticated EXECUTE (see 20260748).
REVOKE ALL ON FUNCTION prune_anonymous_guests(INTERVAL, INT, BOOLEAN)
  FROM public, anon, authenticated;
