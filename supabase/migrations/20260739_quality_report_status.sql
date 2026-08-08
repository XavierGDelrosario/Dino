-- =========================================================
-- Quality reports: a STATUS so a triaged report can be closed out (docs/TODO.md §8).
-- The log was append-only-in-practice — every observation ever filed stayed in the
-- list forever, so a report you'd already fixed was indistinguishable from one still
-- outstanding, and the panel got less useful the more it was used. `status` is the
-- completion flag: 'open' (default, what every existing row backfills to) → 'resolved'.
--
-- Deliberately a 2-state flag, not a workflow: this is a one-admin QA notebook, so
-- "did I deal with this yet" is the only question it needs to answer. resolved_at /
-- resolved_by record WHEN and WHO closed it (same non-FK rationale as reported_by:
-- the note should outlive the account).
--
-- Reopening is allowed (a "fix" that didn't hold goes back on the list) and CLEARS
-- the resolution stamps rather than keeping a stale one.
-- =========================================================

ALTER TABLE quality_reports
  ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved')),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT;                -- auth.uid() of the closer; NOT a FK

-- The panel's default view is "what's still open", so make that the cheap query.
CREATE INDEX IF NOT EXISTS idx_quality_reports_status
  ON quality_reports (status, reported_at DESC);

-- Read. Admin-only. Open reports FIRST (the ones that still need work), then newest
-- first within each group; `p_status` narrows to one state, NULL = all.
-- (Return shape changed — the old signature must be dropped before redefining.)
DROP FUNCTION IF EXISTS admin_quality_reports(INT);
CREATE OR REPLACE FUNCTION admin_quality_reports(p_limit INT DEFAULT 200, p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id          BIGINT,
  reported_at TIMESTAMPTZ,
  reported_by TEXT,
  input       TEXT,
  description TEXT,
  status      TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'status must be open or resolved' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT q.id, q.reported_at, q.reported_by, q.input, q.description,
           q.status, q.resolved_at, q.resolved_by
      FROM quality_reports q
     WHERE p_status IS NULL OR q.status = p_status
     ORDER BY (q.status = 'open') DESC, q.reported_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION admin_quality_reports(INT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_quality_reports(INT, TEXT) TO anon, authenticated;

-- Complete (or reopen) a report. Admin-only. Idempotent: setting the status a row
-- already has is a no-op that returns the row unchanged, EXCEPT that re-resolving
-- refreshes the stamp — closing twice is not an error worth surfacing in a QA log.
CREATE OR REPLACE FUNCTION admin_set_quality_report_status(p_id BIGINT, p_status TEXT)
RETURNS quality_reports
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row quality_reports;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'status must be open or resolved' USING ERRCODE = '22023';
  END IF;

  UPDATE quality_reports
     SET status      = p_status,
         -- Reopening drops the resolution stamp; keeping it would claim the report
         -- was closed at a time it is demonstrably not closed.
         resolved_at = CASE WHEN p_status = 'resolved' THEN now() END,
         resolved_by = CASE WHEN p_status = 'resolved' THEN (auth.uid())::text END
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality report % not found', p_id USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION admin_set_quality_report_status(BIGINT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_set_quality_report_status(BIGINT, TEXT) TO anon, authenticated;
