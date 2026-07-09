-- =========================================================
-- Materialize the per-entry headword resolution (perf).
--
-- jmdict_entry_headword(entry_id) recomputes, PER CALL, the preferred kanji/kana
-- (indexed scan + sort each), the uk flag, and the primary sense's POS — ~4
-- sub-lookups. It's called once per matched entry by wordnet_en_ja_lookup[_many]
-- and learn_words_at_band, and EN→JA reverse lookups match hundreds of entries,
-- so the same static result is recomputed constantly (measured: WordNet EN→JA
-- ~200 ms–1 s, dominated by this).
--
-- The output is a PURE function of static JMdict data, so compute it ONCE for all
-- entries and store it. jmdict_entry_headword() becomes a thin reader over the MV
-- (a simple SQL function → the planner inlines it, so a `LATERAL
-- jmdict_entry_headword(e.entry_id)` collapses to a PK index join). Every caller
-- gets the speedup with IDENTICAL output — the MV is built from the same logic —
-- so no behavior change, no cache churn.
--
-- Staleness: the source is static JMdict, (re)loaded by the truncate-and-reload
-- ingest, so scripts/ingest-jmdict.ts REFRESHes the MV at the end. No live drift.
-- ~217k rows ≈ 15 MB. Server-only (service_role), like the jmdict_* source.
-- =========================================================

DROP MATERIALIZED VIEW IF EXISTS jmdict_entry_headword_mv;

CREATE MATERIALIZED VIEW jmdict_entry_headword_mv AS
  SELECT
    e.entry_id,
    CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END   AS writing,
    CASE WHEN uk.is_uk THEN NULL   ELSE ka.text END                       AS reading,
    COALESCE(kj.common, ka.common, FALSE)                                 AS is_common,
    -- OWN value of the shown writing (kanji's if a kanji is shown, else kana's).
    CASE WHEN uk.is_uk        THEN ka.frequency
         WHEN kj.text IS NOT NULL THEN kj.frequency
         ELSE ka.frequency END                                            AS frequency,
    CASE WHEN uk.is_uk        THEN ka.proficiency_band
         WHEN kj.text IS NOT NULL THEN kj.proficiency_band
         ELSE ka.proficiency_band END                                     AS proficiency_band,
    (SELECT sn.part_of_speech FROM jmdict_senses sn
      WHERE sn.entry_id = e.entry_id ORDER BY sn.position ASC LIMIT 1)    AS part_of_speech
  FROM jmdict_entries e
  LEFT JOIN LATERAL (
    SELECT kk.text, kk.common, kk.frequency, kk.proficiency_band
      FROM jmdict_kanji kk WHERE kk.entry_id = e.entry_id
     ORDER BY kk.common DESC, kk.position ASC LIMIT 1
  ) kj ON TRUE
  LEFT JOIN LATERAL (
    SELECT nn.text, nn.common, nn.frequency, nn.proficiency_band
      FROM jmdict_kana nn WHERE nn.entry_id = e.entry_id
     ORDER BY nn.common DESC, nn.position ASC LIMIT 1
  ) ka ON TRUE
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                      WHERE sn.entry_id = e.entry_id
                      ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
  ) uk;

-- Unique index → the PK probe the readers use (and lets a future REFRESH … CONCURRENTLY work).
CREATE UNIQUE INDEX idx_jmdict_headword_mv_entry ON jmdict_entry_headword_mv (entry_id);

-- Server-only, like the jmdict_* source tables (only the edge's service_role reads it).
REVOKE ALL   ON jmdict_entry_headword_mv FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON jmdict_entry_headword_mv TO service_role;

-- Thin reader: a simple SQL function the planner inlines into a PK join. Same
-- signature + output as before, so every caller is unchanged. CREATE OR REPLACE
-- preserves the existing grants (service_role only, anon revoked in 20260725).
CREATE OR REPLACE FUNCTION jmdict_entry_headword(p_entry_id TEXT)
RETURNS TABLE(writing TEXT, reading TEXT, is_common BOOLEAN, frequency INTEGER,
              proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE sql STABLE
AS $$
  SELECT h.writing, h.reading, h.is_common, h.frequency, h.proficiency_band, h.part_of_speech
    FROM jmdict_entry_headword_mv h
   WHERE h.entry_id = p_entry_id;
$$;
