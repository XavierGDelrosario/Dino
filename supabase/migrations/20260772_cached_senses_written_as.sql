-- =========================================================
-- cached_senses() shows an entry the way the term was WRITTEN.
--
-- A cached row keeps the headword of whichever lookup last projected it: the すじ entry
-- (筋/条) was cached by a lookup of 筋, so its row says 筋. The old input-only read never
-- matched that row for 条, so it never showed; 20260771 reads by ENTRY, which is right
-- — and so 条 answered "筋/すじ muscle" at the top, a headword the user did not type.
--
-- jmdict_lookup has always resolved this at lookup time: a non-uk entry reached through
-- one of its kanji writings is shown AS that writing (matched_kanji). This applies the
-- same rule to the cached rows on the way out — display only, the `words` row is not
-- touched — so a cache hit and a fresh lookup show the same headword, and the "written
-- this way" tier (20260769) and the reader's reading overlay see it too.
--
-- Everything else is 20260771 verbatim.
-- =========================================================

CREATE OR REPLACE FUNCTION cached_senses(
  p_terms       TEXT[],
  p_source      TEXT,
  p_target      TEXT,
  p_min_version INT
)
RETURNS TABLE (term TEXT, words JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH t AS (
    -- Bounded: a paragraph's worth of lookup keys, each a word, never an essay.
    SELECT DISTINCT u.term
      FROM unnest(p_terms[1:500]) AS u(term)
     WHERE p_source = 'JA' AND char_length(u.term) BETWEEN 1 AND 200
  ),
  ent AS (
    SELECT t.term, e.entry_id,
           -- Shown as the searched writing: reached through one of its KANJI writings and
           -- not a uk entry (which headwords as its kana). jmdict_lookup's own rule.
           bool_or(e.via_kanji) AND NOT COALESCE(
             (SELECT sn.usually_kana FROM jmdict_senses sn
               WHERE sn.entry_id = e.entry_id ORDER BY sn.position LIMIT 1), FALSE
           ) AS written_as_term
      FROM t
      CROSS JOIN LATERAL (
        SELECT kj.entry_id, TRUE AS via_kanji FROM jmdict_kanji kj WHERE kj.text = t.term
        UNION ALL
        SELECT ka.entry_id, FALSE FROM jmdict_kana ka WHERE ka.text = t.term
      ) e
     GROUP BY t.term, e.entry_id
  ),
  fresh AS (
    SELECT w.* FROM words w
     WHERE w.source_lang = p_source AND w.target_lang = p_target
       AND w.is_verified AND w.projection_version >= p_min_version
  ),
  -- Terms the dictionary knows: answered only when every entry is cached.
  dict_rows AS (
    SELECT ent.term, ent.written_as_term, f.*
      FROM ent JOIN fresh f ON f.jmdict_entry_id = ent.entry_id
  ),
  complete AS (
    SELECT d.term
      FROM dict_rows d
     GROUP BY d.term
    HAVING count(DISTINCT d.jmdict_entry_id) = (SELECT count(*) FROM ent e WHERE e.term = d.term)
  ),
  -- Terms it does not (MT rows): the previous match, unchanged.
  other_rows AS (
    SELECT t.term, FALSE AS written_as_term, f.*
      FROM t JOIN fresh f ON (f.input = t.term OR f.input_reading = t.term)
     WHERE NOT EXISTS (SELECT 1 FROM ent e WHERE e.term = t.term)
  ),
  answered AS (
    SELECT d.* FROM dict_rows d WHERE d.term IN (SELECT term FROM complete)
    UNION ALL
    SELECT o.* FROM other_rows o
  )
  -- ONE ROW PER TERM, senses as a JSON array. PostgREST caps an RPC response at
  -- db-max-rows (1000 on Supabase), and a paragraph's terms carry several thousand
  -- senses between them — a row per sense was silently truncated, and every term past
  -- the cut read as incomplete, i.e. re-resolved on every lookup. Terms are capped at
  -- 500 above, so this shape can never reach the limit.
  SELECT a.term,
         jsonb_agg(
           CASE WHEN a.written_as_term
                THEN jsonb_set(to_jsonb(a) - 'term' - 'written_as_term', '{input}', to_jsonb(a.term))
                ELSE to_jsonb(a) - 'term' - 'written_as_term'
           END
           ORDER BY a.frequency DESC NULLS LAST, a.jmdict_entry_id, a.sense_rank NULLS LAST)
    FROM answered a
   GROUP BY a.term
$$;

REVOKE ALL ON FUNCTION cached_senses(TEXT[], TEXT, TEXT, INT) FROM public;
GRANT EXECUTE ON FUNCTION cached_senses(TEXT[], TEXT, TEXT, INT) TO anon, authenticated, service_role;
