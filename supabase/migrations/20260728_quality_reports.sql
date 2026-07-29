-- =========================================================
-- Admin panel: translation-quality reports (docs/TODO.md §8). A running QA log:
-- while testing, an admin records the INPUT they typed into Translate plus a
-- DESCRIPTION of what was wrong with the result (bad sense order, missing word,
-- wrong reading, MT noise…). It is the durable place those observations land, so
-- they can be triaged against the dictionary/projection later instead of living
-- in a notes app.
--
-- Server-only table (RLS on, no client policies); both the write and the read go
-- through is_admin()-gated SECURITY DEFINER RPCs, so the gate holds even if the
-- client is tampered with. reported_by is intentionally NOT a FK (the note should
-- outlive the account, same rationale as error_log.user_id).
-- =========================================================

CREATE TABLE IF NOT EXISTS quality_reports (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_by TEXT,                                        -- auth.uid() of the admin; NOT a FK
  input       TEXT NOT NULL CHECK (btrim(input) <> ''),    -- what was typed into Translate
  description TEXT NOT NULL CHECK (btrim(description) <> '')  -- what was inaccurate about it
);

CREATE INDEX IF NOT EXISTS idx_quality_reports_reported_at ON quality_reports (reported_at DESC);

-- No client access at all: the RPCs below (definer-owned) are the only door in.
ALTER TABLE quality_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON quality_reports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON quality_reports TO service_role;

-- Write. Admin-only. Trims + rejects empty fields before the CHECKs would.
CREATE OR REPLACE FUNCTION admin_report_quality_issue(p_input TEXT, p_description TEXT)
RETURNS quality_reports
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row quality_reports;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_input), '') = '' THEN
    RAISE EXCEPTION 'input is required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_description), '') = '' THEN
    RAISE EXCEPTION 'description is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO quality_reports (reported_by, input, description)
  VALUES ((auth.uid())::text, btrim(p_input), btrim(p_description))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION admin_report_quality_issue(TEXT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_report_quality_issue(TEXT, TEXT) TO anon, authenticated;

-- Read. Admin-only; newest first, capped at 1000 rows.
CREATE OR REPLACE FUNCTION admin_quality_reports(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id          BIGINT,
  reported_at TIMESTAMPTZ,
  reported_by TEXT,
  input       TEXT,
  description TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT q.id, q.reported_at, q.reported_by, q.input, q.description
      FROM quality_reports q
     ORDER BY q.reported_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION admin_quality_reports(INT) FROM public;
GRANT EXECUTE ON FUNCTION admin_quality_reports(INT) TO anon, authenticated;
