-- =========================================================
-- Batch lookup wrappers (2026-06-27 audit — cold-paragraph N+1). The edge function
-- resolved each cache-miss word with its OWN sequential RPC (two for EN→JA); a fresh
-- 50-word paragraph was 50–100 serial round-trips inside one edge invocation. These
-- set-returning wrappers resolve the whole miss set in ONE round-trip each.
--
-- Each wraps the EXISTING single function via LATERAL over unnest (no body
-- duplication — behavior stays identical), adding an `input` column so the edge can
-- regroup results per search term. WITH ORDINALITY + ORDER BY keeps each input's
-- senses primary-first and the inputs in request order. Same lockdown as the wrapped
-- functions: SECURITY INVOKER (reads jmdict_*/wordnet_* as the caller), service_role
-- EXECUTE only. An input with no matches simply contributes no rows (CROSS JOIN
-- LATERAL drops it) — the edge treats it as a miss and falls through to MT.
-- =========================================================

CREATE OR REPLACE FUNCTION jmdict_lookup_many(p_inputs TEXT[], p_source TEXT, p_target TEXT)
RETURNS TABLE (
  input                TEXT,
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,
  jmdict_entry_id      TEXT,
  frequency            INT,
  part_of_speech       TEXT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT i.input, l.translation, l.input_reading, l.translation_reading,
         l.sense_position, l.writing, l.jmdict_entry_id, l.frequency, l.part_of_speech
  FROM unnest(p_inputs) WITH ORDINALITY AS i(input, ord)
  CROSS JOIN LATERAL jmdict_lookup(i.input, p_source, p_target) AS l
  ORDER BY i.ord, l.sense_position NULLS LAST
$$;
REVOKE EXECUTE ON FUNCTION jmdict_lookup_many(TEXT[], TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_lookup_many(TEXT[], TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION wordnet_en_ja_lookup_many(p_inputs TEXT[])
RETURNS TABLE (
  input                TEXT,
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,
  jmdict_entry_id      TEXT,
  frequency            INT,
  part_of_speech       TEXT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT i.input, l.translation, l.input_reading, l.translation_reading,
         l.sense_position, l.writing, l.jmdict_entry_id, l.frequency, l.part_of_speech
  FROM unnest(p_inputs) WITH ORDINALITY AS i(input, ord)
  CROSS JOIN LATERAL wordnet_en_ja_lookup(i.input) AS l
  ORDER BY i.ord, l.sense_position NULLS LAST
$$;
REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) TO service_role;
