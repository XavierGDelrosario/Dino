-- =========================================================
-- Quality reports carry the OUTPUT too.
--
-- A report so far named a WORD (20260757): the flag sits on a sense in the reader or
-- on a flashcard, and the word is the whole signal. The Translate tab's output box now
-- has a flag of its own, and there the thing being reported is a TRANSLATION — which
-- cannot be re-derived later from the input alone: the MT answer for a sentence is
-- never cached, and a dictionary answer changes when the projection does. So the
-- report stores what the user was actually shown.
--
-- WHAT CHANGES
--   output   what the output box held when the flag was pressed. NULL for every word
--            report (reader, flashcards) and every admin note — nothing is backfilled.
--   report_quality_issue gains p_output. A defaulted trailing parameter, so a client
--            built before this migration (which sends three named arguments) keeps
--            resolving to the same function. The old 3-argument signature has to be
--            dropped first, or the two would be ambiguous for exactly those callers.
--   admin_quality_reports returns the new column (return shape changed → drop first,
--            as in 20260739 / 20260757).
--
-- LENGTH. The input used to be a word; it can now be a pasted paragraph, and so can
-- the output. Both are clamped in the function — the endpoint is reachable by every
-- guest, and the daily cap bounds the row count but not the row size.
-- =========================================================

ALTER TABLE quality_reports ADD COLUMN IF NOT EXISTS output TEXT;

DROP FUNCTION IF EXISTS report_quality_issue(TEXT, TEXT, UUID);
CREATE FUNCTION report_quality_issue(
  p_input       TEXT,
  p_description TEXT DEFAULT NULL,
  p_word_id     UUID DEFAULT NULL,
  p_output      TEXT DEFAULT NULL
)
RETURNS quality_reports
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  c_daily_cap CONSTANT INT := 30;     -- per user per rolling 24h
  c_max_text  CONSTANT INT := 5000;   -- input / output, each
  c_max_note  CONSTANT INT := 2000;
  v_uid  TEXT := (auth.uid())::text;
  v_desc TEXT := nullif(btrim(coalesce(p_description, '')), '');
  v_out  TEXT := nullif(btrim(coalesce(p_output, '')), '');
  v_row  quality_reports;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'sign-in required' USING ERRCODE = '42501';
  END IF;
  -- The input is filled in by the UI from the word, card or text being reported, so an
  -- empty one means a caller bug rather than a user typing nothing.
  IF coalesce(btrim(p_input), '') = '' THEN
    RAISE EXCEPTION 'input is required' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM quality_reports
       WHERE reported_by = v_uid
         AND source = 'user'
         AND reported_at > now() - interval '24 hours') >= c_daily_cap THEN
    RAISE EXCEPTION 'report limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO quality_reports (reported_by, input, description, source, dictionary_word_id, output)
  VALUES (v_uid, left(btrim(p_input), c_max_text), left(v_desc, c_max_note), 'user',
          p_word_id, left(v_out, c_max_text))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION report_quality_issue(TEXT, TEXT, UUID, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION report_quality_issue(TEXT, TEXT, UUID, TEXT) TO anon, authenticated;

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
  dictionary_word_id UUID,
  output             TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT q.id, q.reported_at, q.reported_by, q.input, q.description, q.status,
           q.resolved_at, q.resolved_by, q.source, q.dictionary_word_id, q.output
      FROM quality_reports q
     WHERE p_status IS NULL OR q.status = p_status
     ORDER BY (q.status = 'open') DESC, q.reported_at DESC
     LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION admin_quality_reports(INT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION admin_quality_reports(INT, TEXT) TO anon, authenticated;
