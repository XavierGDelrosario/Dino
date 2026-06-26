-- =========================================================
-- DINO — Japanese WordNet source (EN->JA quality).
--
-- WHY: the EN->JA direction in jmdict_lookup() is a REVERSE GLOSS SEARCH — it
-- returns every Japanese entry whose English gloss merely MENTIONS the input as a
-- whole word, then ranks by head-match tier + frequency. That has no sense
-- disambiguation: "spring" (season / coil / water source) collapses into one
-- undifferentiated list, and gloss-substring hits surface words that aren't real
-- translations of the concept.
--
-- This adds the bond-lab Japanese WordNet as a SEMANTIC source for EN->JA. An
-- English lemma maps to its WordNet SYNSETS (concept clusters, ordered by sense
-- rank), and each synset carries the Japanese lemmas that express that concept.
-- Each Japanese candidate is then RESOLVED THROUGH JMdict (wordnet_en_ja_lookup
-- below) so it keeps an authoritative reading/furigana, corpus frequency, POS, and
-- the stable jmdict_entry_id — i.e. the results slot into the existing `words`
-- cache with ZERO identity-scheme change (dictionary_ref stays '<input>:<entry>').
--
-- Architecture (mirrors the jmdict_* source, see 20260618_jmdict.sql):
--   * wordnet_*  — normalized WordNet, server-only (RLS on, no policies/grants);
--                  only the edge function (service role, bypasses RLS) reads them
--                  via wordnet_en_ja_lookup().
--   * The edge function calls WordNet FIRST for EN->JA, then falls back to the
--     jmdict_lookup gloss search for English words WordNet lacks, then MT.
--   * `words` stays the lazy verified cache; nothing JA->EN changes.
--
-- Source: Japanese WordNet 1.1 (https://bond-lab.github.io/wnja/). BSD-like for the
-- Japanese data; Princeton WordNet license for the English side. Attribution
-- required (see ATTRIBUTION.md). Loaded by scripts/ingest-wordnet.ts.
-- =========================================================

-- =========================
-- 1. WORDNET — normalized source tables
-- =========================

-- One row per Princeton WordNet synset (a concept). synset_id like '04468005-n';
-- the trailing letter is the POS (n/v/a/r). definition_en is the English gloss.
CREATE TABLE IF NOT EXISTS wordnet_synsets (
  synset_id      TEXT PRIMARY KEY,
  pos            TEXT NOT NULL,                 -- n / v / a / r (synset POS)
  definition_en  TEXT
);

-- English lemma -> synset, with the Princeton sense RANK (lower = more frequent
-- sense of that lemma). The driver for EN->JA sense ordering. lemma is lowercased.
CREATE TABLE IF NOT EXISTS wordnet_senses_en (
  id          BIGSERIAL PRIMARY KEY,
  lemma       TEXT NOT NULL,                    -- lowercased English word
  synset_id   TEXT NOT NULL REFERENCES wordnet_synsets(synset_id) ON DELETE CASCADE,
  sense_rank  INT                               -- NULL = unranked
);

-- Synset -> Japanese lemma (the high-confidence wnjpn-ok set). `confidence` is the
-- source tag (hand / mono / lex / …); stored for provenance, not used in ranking.
CREATE TABLE IF NOT EXISTS wordnet_words_ja (
  id          BIGSERIAL PRIMARY KEY,
  synset_id   TEXT NOT NULL REFERENCES wordnet_synsets(synset_id) ON DELETE CASCADE,
  lemma       TEXT NOT NULL,                    -- NFC-normalized Japanese surface
  confidence  TEXT
);

-- Indexes -------------------------------------------------------------------
-- EN lemma -> synsets (the lookup entry point); JA lemmas per synset (the join).
CREATE INDEX IF NOT EXISTS idx_wordnet_senses_en_lemma ON wordnet_senses_en (lemma);
CREATE INDEX IF NOT EXISTS idx_wordnet_senses_en_synset ON wordnet_senses_en (synset_id);
CREATE INDEX IF NOT EXISTS idx_wordnet_words_ja_synset  ON wordnet_words_ja  (synset_id);
CREATE INDEX IF NOT EXISTS idx_wordnet_words_ja_lemma   ON wordnet_words_ja  (lemma);

-- RLS: server-side access only — no policies, no grants for anon/authenticated
-- (same lockdown as jmdict_*). The service role bypasses RLS.
ALTER TABLE wordnet_synsets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wordnet_senses_en  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wordnet_words_ja   ENABLE ROW LEVEL SECURITY;

-- =========================
-- 2. jmdict_entry_headword() — shared per-entry headword resolution
-- Factor out the "resolve a JMdict entry to its (writing, reading, common,
-- frequency, POS)" logic that the EN->JA branch of jmdict_lookup builds inline, so
-- wordnet_en_ja_lookup reuses the SAME rules (uk → kana headword + no furigana;
-- else preferred kanji headword + kana reading; headword-surface frequency, not a
-- max over readings). jmdict_lookup keeps its own inline copy (left untouched to
-- avoid destabilizing a working function); this is the canonical version new code
-- should call.
-- =========================
CREATE OR REPLACE FUNCTION jmdict_entry_headword(p_entry_id TEXT)
RETURNS TABLE (
  writing         TEXT,
  reading         TEXT,
  is_common       BOOLEAN,
  frequency       INT,
  part_of_speech  TEXT[]
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    -- "usually kana" entries headline as kana (これ, not 此れ); else preferred kanji.
    CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END   AS writing,
    -- a kana headword needs no furigana; a kanji headword reads as its kana.
    CASE WHEN uk.is_uk THEN NULL ELSE ka.text END                        AS reading,
    COALESCE(kj.common, ka.common, FALSE)                                AS is_common,
    -- frequency of the HEADWORD surface (kana for uk, else preferred kanji then
    -- kana) — not a max over readings, so a shared kana can't inflate a rare kanji.
    CASE WHEN uk.is_uk THEN ka.frequency
         ELSE COALESCE(kj.frequency, ka.frequency) END                   AS frequency,
    (SELECT sn.part_of_speech FROM jmdict_senses sn
      WHERE sn.entry_id = p_entry_id ORDER BY sn.position ASC LIMIT 1)   AS part_of_speech
  FROM (SELECT kk.text, kk.common, kk.frequency FROM jmdict_kanji kk
         WHERE kk.entry_id = p_entry_id
         ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
  FULL JOIN (SELECT nn.text, nn.common, nn.frequency FROM jmdict_kana nn
              WHERE nn.entry_id = p_entry_id
              ORDER BY nn.common DESC, nn.position ASC LIMIT 1) ka ON TRUE
  -- uk = the PRIMARY (position-0) sense tagged "usually kana" for this entry.
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                      WHERE sn.entry_id = p_entry_id
                      ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
  ) uk;
$$;

-- =========================
-- 3. wordnet_en_ja_lookup() — semantic EN->JA via synsets
-- Returns the SAME column shape as jmdict_lookup (translation, input_reading,
-- translation_reading, sense_position, writing, jmdict_entry_id, frequency,
-- part_of_speech) so the edge function's projection consumes it unchanged.
--
--   1. synsets for the English lemma, carrying the Princeton sense_rank
--      (lower = more frequent sense → drives ordering).
--   2. Japanese lemmas in those synsets; per lemma keep the MIN sense_rank
--      (a lemma can belong to several synsets).
--   3. resolve each JA lemma to its best JMdict entry (match a kanji writing OR a
--      kana reading; prefer common, then higher frequency), then resolve the
--      entry's headword/reading/freq/POS via jmdict_entry_headword(). A JA lemma
--      with no JMdict entry is DROPPED (no reading-less / freq-less rows — every
--      result carries authoritative furigana, matching the words-cache model).
--   4. dedupe by entry, order by sense_rank then frequency, cap at 12.
-- =========================
CREATE OR REPLACE FUNCTION wordnet_en_ja_lookup(p_input TEXT)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,   -- always NULL for EN->JA (mirrors jmdict_lookup)
  jmdict_entry_id      TEXT,
  frequency            INT,
  part_of_speech       TEXT[]
)
LANGUAGE sql
STABLE
AS $$
  WITH syn AS (
    -- synsets for the English lemma (lowercased; input is NFC-normalized upstream).
    SELECT se.synset_id, MIN(se.sense_rank) AS rank
      FROM wordnet_senses_en se
     WHERE se.lemma = lower(btrim(p_input))
     GROUP BY se.synset_id
  ),
  ja AS (
    -- Japanese lemmas across those synsets; best (lowest) sense_rank per lemma.
    SELECT wj.lemma, MIN(syn.rank) AS rank
      FROM wordnet_words_ja wj
      JOIN syn ON syn.synset_id = wj.synset_id
     GROUP BY wj.lemma
  ),
  resolved AS (
    -- resolve each JA lemma to its single best JMdict entry, then its headword.
    SELECT e.entry_id, ja.rank,
           hw.writing, hw.reading, hw.is_common, hw.frequency, hw.part_of_speech
      FROM ja
      JOIN LATERAL (
        SELECT cand.entry_id
          FROM (
            SELECT kj.entry_id, kj.common AS c, kj.frequency AS f, 0 AS src
              FROM jmdict_kanji kj WHERE kj.text = ja.lemma
            UNION ALL
            SELECT ka.entry_id, ka.common, ka.frequency, 1
              FROM jmdict_kana ka WHERE ka.text = ja.lemma
          ) cand
         -- prefer a common surface, then a higher-frequency one, kanji over kana.
         ORDER BY cand.c DESC, cand.f DESC NULLS LAST, cand.src ASC
         LIMIT 1
      ) e ON TRUE
      CROSS JOIN LATERAL jmdict_entry_headword(e.entry_id) hw
  ),
  dedup AS (
    -- one row per entry (a synset's lemmas, or a lemma's homographs, can collide
    -- on the same entry); keep the best-ranked occurrence.
    SELECT DISTINCT ON (r.entry_id)
           r.entry_id, r.rank, r.writing, r.reading,
           r.is_common, r.frequency, r.part_of_speech
      FROM resolved r
     WHERE r.writing IS NOT NULL
     ORDER BY r.entry_id, r.rank ASC NULLS LAST, r.frequency DESC NULLS LAST
  )
  SELECT
    d.writing                                                   AS translation,
    NULL::TEXT                                                  AS input_reading,
    d.reading                                                   AS translation_reading,
    -- contiguous rank: WordNet sense order first (more-frequent senses lead), then
    -- corpus frequency, then the common flag.
    (ROW_NUMBER() OVER (ORDER BY d.rank ASC NULLS LAST,
                                 d.frequency DESC NULLS LAST,
                                 d.is_common DESC))::INT - 1     AS sense_position,
    NULL::TEXT                                                  AS writing,
    d.entry_id                                                  AS jmdict_entry_id,
    d.frequency                                                 AS frequency,
    d.part_of_speech                                            AS part_of_speech
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$$;

-- =========================
-- 4. GRANTs — server-side only (mirrors jmdict_*)
-- =========================
-- Only the service role may call the lookups; they read the locked-down source
-- tables (functions are SECURITY INVOKER, so clients — which have no table grant
-- and no EXECUTE — get nothing).
REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION jmdict_entry_headword(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_entry_headword(TEXT) TO service_role;

GRANT SELECT ON wordnet_synsets, wordnet_senses_en, wordnet_words_ja TO service_role;
