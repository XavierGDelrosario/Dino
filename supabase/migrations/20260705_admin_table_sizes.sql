-- =========================================================
-- Admin panel: DB usage by table (docs/TODO.md §8 — storage headroom vs the tier
-- cap). Read-only. Same gate pattern as admin_usage_overview: SECURITY DEFINER so
-- it can read the catalog regardless of the caller's grants, but it refuses any
-- non-admin caller via is_admin(). No PII — pure size metadata.
-- =========================================================

CREATE OR REPLACE FUNCTION admin_table_sizes()
RETURNS TABLE (
  table_name   TEXT,
  total_bytes  BIGINT,  -- heap + toast + indexes (what counts against the cap)
  table_bytes  BIGINT,  -- heap + toast only (indexes = total - table)
  row_estimate BIGINT   -- planner estimate (reltuples; approximate, post-ANALYZE)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT c.relname::text,
           pg_total_relation_size(c.oid)::bigint,
           pg_table_size(c.oid)::bigint,
           GREATEST(c.reltuples, 0)::bigint
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'           -- ordinary tables only (no views / indexes)
     ORDER BY pg_total_relation_size(c.oid) DESC;
END;
$$;
REVOKE ALL ON FUNCTION admin_table_sizes() FROM public;
GRANT EXECUTE ON FUNCTION admin_table_sizes() TO anon, authenticated;
