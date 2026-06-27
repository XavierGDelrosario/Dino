-- =========================================================
-- Idempotency-key pruning (2026-06-27 audit, S6). idempotency_keys grows forever —
-- every paid single-MT request with a key inserts a permanent row, nothing prunes
-- them. created_at already exists; this adds the cleanup.
--
-- Ships three things, most-to-least portable:
--   1. An index on created_at so the prune is a range scan, not a seq scan.
--   2. prune_idempotency_keys() — deletes replay records older than 7 days (a
--      generous retry window). Callable manually or by any scheduler.
--   3. A daily pg_cron schedule WHERE AVAILABLE — wrapped non-fatal so the migration
--      still succeeds if pg_cron can't be enabled in this environment (then schedule
--      the function via Supabase Cron, or run it manually).
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);

CREATE OR REPLACE FUNCTION prune_idempotency_keys() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days';
$$;
REVOKE ALL ON FUNCTION prune_idempotency_keys() FROM public; -- server/cron only

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  -- cron.schedule(jobname, …) is upsert-by-name in pg_cron ≥ 1.4.
  PERFORM cron.schedule('prune-idempotency-keys', '17 3 * * *',
                        'SELECT public.prune_idempotency_keys()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule prune_idempotency_keys() manually / via Supabase Cron', SQLERRM;
END $$;
