-- =========================================================
-- IDEMPOTENCY KEYS for the `translate` edge function.
--
-- The translate client RETRIES transient failures (5xx / dropped connection). A
-- request that already SUCCEEDED server-side but whose response was lost on the way
-- back would, on retry, re-run the PAID MT path: re-call Google AND re-reserve the
-- monthly quota. (The cached word paths are already idempotent — a retry hits the
-- verified `words` cache. The exposed path is the persist=false paragraph gloss,
-- which always goes to MT and is never cached.)
--
-- The edge stores the response of a paid request under the client's per-request key
-- and replays it verbatim on a repeat, so a retry costs nothing. Sequential-retry
-- safe (the retry runs after the first completed); a true concurrent double-submit
-- is out of scope (retries aren't concurrent).
--
-- Server-only, like the other edge-owned tables: RLS on, NO client policies/grants;
-- only the service role reads/writes it. Keys are disposable — a deploy-time cron
-- prunes old rows (see idx on created_at); the POC leaves them.
-- =========================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  status     INT  NOT NULL DEFAULT 200,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For the TTL prune job (DELETE WHERE created_at < now() - interval).
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys (created_at);

-- Server-only: RLS on with no policies/grants to anon/authenticated. The service
-- role bypasses RLS but still needs the table GRANT (RLS-bypass != privilege).
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO service_role;
