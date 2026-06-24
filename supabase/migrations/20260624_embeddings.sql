-- =========================================================
-- WORD EMBEDDINGS (#11) — the relatedness / "word map" axis.
--
-- A SEPARATE subsystem from `words` (the difficulty axis lives there; relatedness
-- lives here) so re-embedding never churns the dictionary cache. Off-the-shelf
-- multilingual vectors (multilingual-e5-small, 384-dim) over JMdict entries; the
-- nearest neighbours by cosine distance are semantically related words (domain
-- clusters: volleyball terms together, legal terms together). We BORROW the
-- embedding space — nothing is trained here.
--
-- Server-only, like the jmdict_* source tables: RLS on, NO client policies/grants.
-- Clients reach it ONLY through related_words() (SECURITY DEFINER). Vectors are
-- generated out-of-band by scripts/build-embeddings.py (a one-time/regeneration
-- job, like the JMdict + frequency ingest), NOT at request time.
--
-- Embedding text is ENTRY-LEVEL ("<writing>: <glosses>"), so one vector per entry.
-- Per-SENSE embedding (a homograph's blended vector) is a later refinement; entry
-- granularity is enough for domain/relatedness clustering.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- MULTI-LANGUAGE KEY: identity is (source_lang, dictionary_ref), NOT a JMdict FK.
-- `dictionary_ref` is the per-source ENTRY id (JMdict entry_id for JA; CC-CEDICT id
-- for ZH; a KR dict's id for KO; ...) and `source_lang` scopes it, so different
-- sources can share an id string without colliding. Deliberately NO FK to
-- jmdict_entries — that coupling would block any non-JA source. The shared
-- multilingual embedding space means every language's vectors live in this one
-- table; only the PROJECTION (writing/gloss/frequency in related_words) is still
-- JMdict-specific today — that becomes per-source when a 2nd dictionary ships.
CREATE TABLE IF NOT EXISTS word_embeddings (
  source_lang     TEXT NOT NULL,                 -- the embedded entry's language (JA today)
  dictionary_ref  TEXT NOT NULL,                 -- per-source entry id (JMdict entry_id for JA)
  embedding       vector(384) NOT NULL,          -- multilingual-e5-small dimensionality
  model           TEXT NOT NULL,                 -- which model produced it (re-embed tracking)
  embedded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_lang, dictionary_ref)
);

-- Approximate-nearest-neighbour index. HNSW (pgvector ≥0.5) for cosine distance —
-- e5 vectors are compared by cosine. Built once; queried by related_words().
CREATE INDEX IF NOT EXISTS idx_word_embeddings_hnsw
  ON word_embeddings USING hnsw (embedding vector_cosine_ops);

-- Server-only: enable RLS with NO policies and NO grants, so clients can't read
-- raw vectors. The only door in is related_words() below.
ALTER TABLE word_embeddings ENABLE ROW LEVEL SECURITY;

-- related_words(entry_id, limit) -> the N most semantically-related entries, each
-- with a representative writing + its primary-sense glosses + the cosine distance
-- (0 = identical … 2 = opposite). Empty if the entry hasn't been embedded yet.
-- SECURITY DEFINER so it can read the server-only embeddings + jmdict_* tables;
-- it exposes only derived, public dictionary content (writing/gloss), never vectors.
--
-- p_entry_id is a JA (JMdict) dictionary_ref. The KEY layer is multi-language, but
-- the PROJECTION below (writing/gloss/frequency via jmdict_*) is JA-only, so this
-- scopes to source_lang = 'JA'. A 2nd language gets its OWN projector
-- (related_words_<src>, or a source-routed body) reading its own dictionary tables
-- — neighbours must be same-language anyway. Signature unchanged for callers.
CREATE OR REPLACE FUNCTION related_words(p_entry_id TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE (
  entry_id  TEXT,
  writing   TEXT,
  gloss     TEXT,
  frequency INT,    -- the headword's wordfreq score (for client-side level filtering, #12)
  distance  REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target vector(384);
BEGIN
  SELECT we.embedding INTO v_target FROM word_embeddings we
    WHERE we.dictionary_ref = p_entry_id AND we.source_lang = 'JA';
  IF v_target IS NULL THEN
    RETURN; -- not embedded → no neighbours
  END IF;

  RETURN QUERY
  SELECT
    we.dictionary_ref,
    -- representative writing: preferred kanji (common, then most frequent), else kana
    COALESCE(
      (SELECT k.text FROM jmdict_kanji k
        WHERE k.entry_id = we.dictionary_ref
        ORDER BY k.common DESC, k.frequency DESC NULLS LAST, k.id LIMIT 1),
      (SELECT n.text FROM jmdict_kana n
        WHERE n.entry_id = we.dictionary_ref
        ORDER BY n.common DESC, n.frequency DESC NULLS LAST, n.id LIMIT 1)
    ),
    -- glosses of the entry's PRIMARY (lowest-id) sense, joined
    (SELECT string_agg(g.text, '; ' ORDER BY g.position)
       FROM jmdict_senses s
       JOIN jmdict_glosses g ON g.sense_id = s.id
      WHERE s.entry_id = we.dictionary_ref
        AND s.id = (SELECT MIN(s2.id) FROM jmdict_senses s2 WHERE s2.entry_id = we.dictionary_ref)),
    -- headword frequency (preferred kanji, else kana) — same pick as `writing`.
    COALESCE(
      (SELECT k.frequency FROM jmdict_kanji k
        WHERE k.entry_id = we.dictionary_ref
        ORDER BY k.common DESC, k.frequency DESC NULLS LAST, k.id LIMIT 1),
      (SELECT n.frequency FROM jmdict_kana n
        WHERE n.entry_id = we.dictionary_ref
        ORDER BY n.common DESC, n.frequency DESC NULLS LAST, n.id LIMIT 1)
    ),
    (we.embedding <=> v_target)::REAL
  FROM word_embeddings we
  WHERE we.source_lang = 'JA' AND we.dictionary_ref <> p_entry_id
  ORDER BY we.embedding <=> v_target   -- cosine distance; uses the HNSW index
  LIMIT GREATEST(0, p_limit);
END;
$$;

REVOKE EXECUTE ON FUNCTION related_words(TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION related_words(TEXT, INT) TO anon, authenticated;
