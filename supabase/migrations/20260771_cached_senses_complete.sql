-- =========================================================
-- cached_senses(): the dictionary cache answers a Japanese term only when it holds
-- EVERY entry the dictionary has for it.
--
-- THE GAP. `words` is a lazy cache, and both cache reads (the client's and the edge's)
-- served whatever rows matched a term — even an incomplete set. They match the term
-- against `input` OR `input_reading`, so once a kana lookup of たち had cached that uk
-- entry (headword たち, kanji 質 in input_reading), a later lookup of 質 was a cache HIT
-- with only たち's rows and never reached jmdict_lookup. On prod (2026-09-15) 質 answered
-- "nature (of a person)" and nothing else; "quality" was simply absent.
--
-- It is not rare and there is no cheap tell. Measured on prod over the kanji spellings
-- reachable through input_reading: 68 cached sets were incomplete, and 16 of those even
-- had a row headworded as the term — while 276 COMPLETE sets had none (概ね has only a uk
-- entry). "Reading-only hit = miss" would have missed the first and re-resolved the
-- second forever. Completeness has to be judged against the dictionary itself.
--
-- THE RULE, for source JA:
--   · the term's entries are every JMdict entry with a writing or reading equal to it —
--     the same WHERE jmdict_lookup uses, so it is exactly the set a resolution projects;
--   · the term is answered only if each of those entries has a fresh cached row; the
--     rows are then the ones for those entries (which also finds writing variants the
--     old input/input_reading match never could: 条 now sees くだり, written 件/条/行);
--   · a term with no JMdict entry (an MT row) falls back to input / input_reading.
-- An incomplete term returns nothing, which callers already treat as a miss: the edge
-- re-resolves it through jmdict_lookup (free — dictionary, not MT) and the upsert fills
-- the gaps in place. So existing partial sets heal on their next lookup; no data change.
--
-- WHY A FUNCTION. jmdict_* is server-only, and the client reads `words` directly and
-- serves a hit without asking the edge — so the client cannot judge completeness on its
-- own. SECURITY DEFINER lets it ask, and it returns only `words` rows (already public to
-- every client). It is also the one place the rule lives: the edge calls it too, rather
-- than a third hand-mirrored copy of the matching logic.
--
-- Callers degrade to their previous read if this function is missing (PGRST202/42883).
-- =========================================================

-- The entry-id join below needs its own index (the cache was only ever read by input).
CREATE INDEX IF NOT EXISTS idx_words_jmdict_entry
  ON words (jmdict_entry_id, source_lang, target_lang)
  WHERE jmdict_entry_id IS NOT NULL;

DROP FUNCTION IF EXISTS cached_senses(TEXT[], TEXT, TEXT, INT);
CREATE FUNCTION cached_senses(
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
    SELECT t.term, e.entry_id
      FROM t
      CROSS JOIN LATERAL (
        SELECT kj.entry_id FROM jmdict_kanji kj WHERE kj.text = t.term
        UNION
        SELECT ka.entry_id FROM jmdict_kana ka WHERE ka.text = t.term
      ) e
  ),
  fresh AS (
    SELECT w.* FROM words w
     WHERE w.source_lang = p_source AND w.target_lang = p_target
       AND w.is_verified AND w.projection_version >= p_min_version
  ),
  -- Terms the dictionary knows: answered only when every entry is cached.
  dict_rows AS (
    SELECT ent.term, f.*
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
    SELECT t.term, f.*
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
         jsonb_agg(to_jsonb(a) - 'term'
                   ORDER BY a.frequency DESC NULLS LAST, a.jmdict_entry_id, a.sense_rank NULLS LAST)
    FROM answered a
   GROUP BY a.term
$$;

REVOKE ALL ON FUNCTION cached_senses(TEXT[], TEXT, TEXT, INT) FROM public;
GRANT EXECUTE ON FUNCTION cached_senses(TEXT[], TEXT, TEXT, INT) TO anon, authenticated, service_role;
