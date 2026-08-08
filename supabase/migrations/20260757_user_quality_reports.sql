-- =========================================================
-- Let USERS file quality reports, not just the admin.
--
-- `quality_reports` (20260728) was built as a one-admin QA notebook: the write RPC
-- gates on is_admin() and `description` is NOT NULL + non-empty, because an admin
-- filing a note always has something to say. A reader who taps a flag on a word does
-- not: the useful signal is "THIS sense is wrong", and forcing them to type a sentence
-- before that signal is recorded loses most of the reports we would have got.
--
-- Same table on purpose. A user report and an admin note are the same THING — an
-- observation about a specific dictionary result — and splitting them would mean two
-- panels, two triage flows, and a lookup that has to check both. `source` records
-- provenance instead.
--
-- WHAT CHANGES
--   source              'admin' | 'user'. Existing rows are admin notes → the DEFAULT
--                       backfills them correctly, so nothing needs rewriting.
--   dictionary_word_id  the exact SENSE reported, when the surface knows it (the reader
--                       and the flashcards both do). Far better than the headword alone:
--                       辛い has two senses and only one of them is likely wrong. NULL
--                       for an admin note typed as free text, and ON DELETE SET NULL
--                       because the report should outlive a re-projected cache row.
--   description         now optional FOR USER ROWS. The old CHECK is replaced by one
--                       that still demands a description from an admin, so the notebook
--                       behaves exactly as before.
--
-- ABUSE. Every visitor is a real auth user (anonymous guests), so this endpoint is
-- reachable by anyone who loads the site. The RPC caps a user at
-- c_daily_cap reports per rolling 24h and raises when exceeded — enforced server-side
-- in the definer function, not in the client, for the same reason the quota reserve is.
-- The cap is deliberately generous: a real user hitting it is unusual, a script hits it
-- immediately.
-- =========================================================

ALTER TABLE quality_reports
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin'
    CHECK (source IN ('admin', 'user')),
  ADD COLUMN IF NOT EXISTS dictionary_word_id UUID REFERENCES words(word_id) ON DELETE SET NULL;

-- description: optional for a user report, still required from an admin.
ALTER TABLE quality_reports ALTER COLUMN description DROP NOT NULL;
ALTER TABLE quality_reports DROP CONSTRAINT IF EXISTS quality_reports_description_check;
ALTER TABLE quality_reports DROP CONSTRAINT IF EXISTS quality_reports_description_required;
ALTER TABLE quality_reports ADD CONSTRAINT quality_reports_description_required
  CHECK (source <> 'admin' OR coalesce(btrim(description), '') <> '');

-- The panel groups by provenance ("what did users report") — make that cheap.
CREATE INDEX IF NOT EXISTS idx_quality_reports_source
  ON quality_reports (source, status, reported_at DESC);

-- ── User-facing write ──────────────────────────────────────────────────────
-- Any signed-in user, INCLUDING an anonymous guest: a guest is a real user with real
-- vocabulary, and their reports are worth exactly as much as an account holder's.
CREATE OR REPLACE FUNCTION report_quality_issue(
  p_input       TEXT,
  p_description TEXT DEFAULT NULL,
  p_word_id     UUID DEFAULT NULL
)
RETURNS quality_reports
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  c_daily_cap CONSTANT INT := 30;   -- per user per rolling 24h
  v_uid  TEXT := (auth.uid())::text;
  v_desc TEXT := nullif(btrim(coalesce(p_description, '')), '');
  v_row  quality_reports;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'sign-in required' USING ERRCODE = '42501';
  END IF;
  -- The input is filled in by the UI from the word or card being reported, so an empty
  -- one means a caller bug rather than a user typing nothing.
  IF coalesce(btrim(p_input), '') = '' THEN
    RAISE EXCEPTION 'input is required' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM quality_reports
       WHERE reported_by = v_uid
         AND source = 'user'
         AND reported_at > now() - interval '24 hours') >= c_daily_cap THEN
    RAISE EXCEPTION 'report limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO quality_reports (reported_by, input, description, source, dictionary_word_id)
  VALUES (v_uid, btrim(p_input), v_desc, 'user', p_word_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION report_quality_issue(TEXT, TEXT, UUID) FROM public;
GRANT EXECUTE ON FUNCTION report_quality_issue(TEXT, TEXT, UUID) TO anon, authenticated;

-- ── Admin read: surface the new columns ────────────────────────────────────
-- Return shape changed, so the old signature must go first (same as 20260739).
DROP FUNCTION IF EXISTS admin_quality_reports(INT, TEXT);
CREATE FUNCTION admin_quality_reports(p_limit INT DEFAULT 200, p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id                 BIGINT,
  reported_at        TIMESTAMPTZ,
  reported_by        TEXT,
  input              TEXT,
  description        TEXT,
  status             TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_by        TEXT,
  source             TEXT,
  dictionary_word_id UUID
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT q.id, q.reported_at, q.reported_by, q.input, q.description, q.status,
           q.resolved_at, q.resolved_by, q.source, q.dictionary_word_id
      FROM quality_reports q
     WHERE p_status IS NULL OR q.status = p_status
     ORDER BY (q.status = 'open') DESC, q.reported_at DESC
     LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION admin_quality_reports(INT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_quality_reports(INT, TEXT) TO anon, authenticated;
