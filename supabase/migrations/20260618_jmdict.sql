-- =========================================================
-- DINO — JMdict dictionary source (self-hosted, full dataset).
--
-- This is the AUTHORITATIVE dictionary the translate edge function queries.
-- Architecture (see CLAUDE.md):
--   * jmdict_*  — normalized JMdict, the source of truth. NOT exposed to clients
--                 at all (RLS on, no policies, no grants); only the edge function
--                 (service role, which bypasses RLS) reads them.
--   * words     — stays a LAZY verified cache: on a miss the edge function calls
--                 jmdict_lookup(), projects the matched senses into verified
--                 `words` rows, and returns them. (Defined in 20260613_init.sql;
--                 untouched here.)
--   Readings ride INLINE on each `words` row (input_reading / translation_reading)
--   — that is the furigana source for the no-context surface (single-word lookups,
--   flashcards), where kuromoji is unreliable. Sentence/paragraph furigana uses
--   client-side kuromoji (context-aware). There is deliberately NO separate
--   readings table: it would only duplicate `words` readings and can't beat
--   kuromoji's context on the sentence path.
--
-- Source: scriptin/jmdict-simplified `jmdict-eng-*.json` (parsed JMdict JSON).
-- JMdict is owned by EDRDG and used under their licence (attribution required).
-- Loaded by scripts/ingest-jmdict.ts (a one-time, server-side ETL run).
-- =========================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- accelerates the EN->JA whole-word gloss match

-- =========================
-- 1. JMDICT — normalized source tables
-- =========================

-- One row per JMdict entry (its stable JMdict id / ent_seq).
CREATE TABLE IF NOT EXISTS jmdict_entries (
  entry_id TEXT PRIMARY KEY
);

-- Kanji writings (surface forms). Zero rows for a kana-only entry.
CREATE TABLE IF NOT EXISTS jmdict_kanji (
  id        BIGSERIAL PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES jmdict_entries(entry_id) ON DELETE CASCADE,
  text      TEXT NOT NULL,                 -- NFC-normalized writing
  common    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Corpus-frequency score (wordfreq Zipf × 100; HIGHER = more common; NULL =
  -- unranked). Joined onto each writing/reading BY SURFACE at ingest from
  -- data/frequency/ja.tsv (jmdict-simplified itself has no usable frequency — it
  -- collapses all priority codes into `common`). Lets jmdict_lookup ORDER BY
  -- frequency DESC so a reading spanning entries ranks the common one first
  -- (いく→行く≫幾). See scripts/build-frequency.py + CLAUDE.md #7.
  frequency INT,
  position  INT NOT NULL                   -- order within the entry (preferred first)
);

-- Kana readings (always >= 1 per entry).
CREATE TABLE IF NOT EXISTS jmdict_kana (
  id                BIGSERIAL PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES jmdict_entries(entry_id) ON DELETE CASCADE,
  text              TEXT NOT NULL,         -- NFC-normalized kana
  common            BOOLEAN NOT NULL DEFAULT FALSE,
  applies_to_kanji  TEXT[] NOT NULL DEFAULT '{*}',  -- {*} = applies to all kanji forms
  frequency         INT,                   -- see jmdict_kanji.frequency
  position          INT NOT NULL
);

-- Senses (a meaning grouping within an entry).
CREATE TABLE IF NOT EXISTS jmdict_senses (
  id                BIGSERIAL PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES jmdict_entries(entry_id) ON DELETE CASCADE,
  part_of_speech    TEXT[] NOT NULL DEFAULT '{}',   -- POS tag codes (e.g. n, v5k, adj-i)
  applies_to_kanji  TEXT[] NOT NULL DEFAULT '{*}',
  applies_to_kana   TEXT[] NOT NULL DEFAULT '{*}',
  usually_kana      BOOLEAN NOT NULL DEFAULT FALSE, -- JMdict "uk" misc: headline as kana
  position          INT NOT NULL                    -- sense order (0 = primary)
);

-- English glosses, one row per gloss text.
CREATE TABLE IF NOT EXISTS jmdict_glosses (
  id        BIGSERIAL PRIMARY KEY,
  sense_id  BIGINT NOT NULL REFERENCES jmdict_senses(id) ON DELETE CASCADE,
  lang      TEXT NOT NULL DEFAULT 'eng',
  text      TEXT NOT NULL,                 -- the English meaning
  position  INT NOT NULL
);

-- Indexes -------------------------------------------------------------------
-- (a) JA -> EN lookup by surface writing OR kana.
CREATE INDEX IF NOT EXISTS idx_jmdict_kanji_text ON jmdict_kanji (text);
CREATE INDEX IF NOT EXISTS idx_jmdict_kana_text  ON jmdict_kana  (text);
-- FK-join indexes (Postgres does not auto-index FK columns).
CREATE INDEX IF NOT EXISTS idx_jmdict_kanji_entry   ON jmdict_kanji   (entry_id);
CREATE INDEX IF NOT EXISTS idx_jmdict_kana_entry    ON jmdict_kana    (entry_id);
CREATE INDEX IF NOT EXISTS idx_jmdict_senses_entry  ON jmdict_senses  (entry_id);
CREATE INDEX IF NOT EXISTS idx_jmdict_glosses_sense ON jmdict_glosses (sense_id);
-- (b) EN -> JA lookup by gloss: whole-word (case-insensitive `~*`) match, which
--     the trigram GIN index accelerates. JMdict glosses are phrases, so exact
--     equality misses almost everything; word-boundary matching is what works.
CREATE INDEX IF NOT EXISTS idx_jmdict_glosses_trgm  ON jmdict_glosses USING gin (text gin_trgm_ops);

-- RLS: lock the source tables to server-side access only. No policies and no
-- grants => anon/authenticated cannot reach them through the Data API; the
-- service role (edge function / loader) bypasses RLS. Defense-in-depth on top of
-- config.toml's default-deny for new tables.
ALTER TABLE jmdict_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE jmdict_kanji   ENABLE ROW LEVEL SECURITY;
ALTER TABLE jmdict_kana    ENABLE ROW LEVEL SECURITY;
ALTER TABLE jmdict_senses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE jmdict_glosses ENABLE ROW LEVEL SECURITY;

-- =========================
-- 2. jmdict_lookup() — both directions, in SQL
-- Returns one row per projected `words` sense. The edge function maps these to
-- ProviderResult / verified `words` rows. Keeps the join logic server-side so the
-- Deno function stays a thin caller (one RPC round-trip).
--   JA->EN: match input against a kanji writing OR kana; translation = the
--           sense's glosses joined "; ", input_reading = preferred kana.
--   EN->JA: match input as a WHOLE WORD inside a gloss (case-insensitive; JMdict
--           glosses are phrases like "cat (esp. ...)", so exact-equality misses
--           almost everything). Accelerated by the gloss trigram GIN index. One row
--           per matched entry, translation = preferred JA writing, translation_reading
--           = preferred kana; entries with an EXACT gloss rank first, then common.
-- =========================
CREATE OR REPLACE FUNCTION jmdict_lookup(
  p_input  TEXT,
  p_source TEXT,
  p_target TEXT
)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  -- the preferred WRITING of the matched JA entry (kanji if it has one, else
  -- kana). This is the canonical headword the edge function stores as `input`,
  -- so a hiragana search (ねこ) still yields the kanji 猫 — and homophones split
  -- into their own kanji (はし → 橋 / 箸 / 端). NULL for EN->JA.
  writing              TEXT,
  -- the JMdict entry id (ent_seq). The STABLE source identity the edge function
  -- folds into words.dictionary_ref — unlike `writing`/`translation` (projection
  -- outputs that a logic change can move), this never shifts for a given sense.
  -- NOTE: named jmdict_entry_id, NOT entry_id — a RETURNS TABLE column is an OUT
  -- variable in the function body, and bare `entry_id` references in the
  -- subqueries below would then be ambiguous against the table column.
  jmdict_entry_id      TEXT,
  -- Corpus-frequency RANK of the matched entry (min over its kana/kanji; lower =
  -- more common, NULL = unranked). The edge function stores it on words.frequency
  -- (the difficulty axis) AND it drives the ORDER BY below so the common entry of
  -- a shared reading ranks first.
  frequency            INT,
  -- POS tags of the sense (JA→EN) / the entry's first sense (EN→JA). Stored on
  -- words.part_of_speech.
  part_of_speech       TEXT[]
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_source = 'JA' AND p_target = 'EN' THEN
    RETURN QUERY
      SELECT
        (SELECT string_agg(gl.text, '; ' ORDER BY gl.position)
           FROM jmdict_glosses gl
          WHERE gl.sense_id = s.id)                       AS translation,
        -- The annotation shown above the headword (`input_reading`):
        --   * uk entry → the KANJI (headword is kana, so show the kanji as a hint)
        --   * normal entry with kanji → the kana reading (furigana)
        --   * kana-only → nothing
        CASE
          WHEN pref.is_uk THEN pref.kanji                      -- kanji rides above the kana
          WHEN pref.kanji IS NOT NULL THEN pref.kana           -- normal furigana
          ELSE NULL
        END                                               AS input_reading,
        NULL::TEXT                                        AS translation_reading,
        s.position                                        AS sense_position,
        -- Headword (`writing`): kana for "usually kana" entries, else kanji.
        CASE WHEN pref.is_uk THEN pref.kana ELSE COALESCE(pref.kanji, pref.kana) END
                                                          AS writing,
        s.entry_id                                        AS jmdict_entry_id,
        -- Frequency of the HEADWORD's surface, not the max over all readings: the
        -- kana is shared by homophones (いく → 行く/幾/…), so its score would
        -- inflate rare kanji. Use the preferred kanji's score; for uk/kana-only
        -- entries the kana IS the headword (e.g. する), so use the kana's.
        CASE WHEN pref.is_uk THEN pref.kana_freq
             ELSE COALESCE(pref.kanji_freq, pref.kana_freq) END AS frequency,
        s.part_of_speech                                  AS part_of_speech
      FROM jmdict_senses s
      JOIN LATERAL (
        SELECT
          (SELECT kj.text FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji,
          (SELECT k.text FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana,
          -- frequency of those SAME preferred surfaces (same ORDER BY → same row)
          (SELECT kj.frequency FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji_freq,
          (SELECT k.frequency FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana_freq,
          -- is the entry "common" (any common kana/kanji)? Used to rank common
          -- words first when one reading spans several entries (いく → 行く ≫ 幾).
          (COALESCE((SELECT bool_or(common) FROM jmdict_kana  WHERE entry_id = s.entry_id), FALSE)
           OR COALESCE((SELECT bool_or(common) FROM jmdict_kanji WHERE entry_id = s.entry_id), FALSE))
                                                              AS is_common,
          -- "usually kana": the PRIMARY (position 0) sense tagged uk. Must be the
          -- primary, not any sense — 猫's slang senses are uk but its main "cat"
          -- sense isn't, so it must stay 猫, not flip to ねこ.
          COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                     WHERE sn.entry_id = s.entry_id ORDER BY sn.position ASC LIMIT 1), FALSE)
                                                              AS is_uk
      ) pref ON TRUE
      WHERE s.entry_id IN (
              SELECT entry_id FROM jmdict_kanji WHERE text = p_input
              UNION
              SELECT entry_id FROM jmdict_kana  WHERE text = p_input
            )
      -- headword frequency first (higher Zipf = more common) so a shared reading
      -- ranks the common entry ahead of the rare one (いく→行く≫幾); NULLs last.
      -- Same CASE as the projected `frequency` (qualified pref refs, so no clash
      -- with the `frequency` OUT variable). is_common is the coarse tiebreaker.
      ORDER BY (CASE WHEN pref.is_uk THEN pref.kana_freq
                     ELSE COALESCE(pref.kanji_freq, pref.kana_freq) END) DESC NULLS LAST,
               pref.is_common DESC, s.entry_id, s.position;

  ELSIF p_source = 'EN' AND p_target = 'JA' THEN
    RETURN QUERY
      WITH ent AS (
        SELECT s.entry_id,
               MIN(s.position) AS first_sense,
               -- relevance: 3 = a gloss IS the input, 2 = the input is the gloss's
               -- whole head term, followed only by a clarifier/punctuation
               -- ("cat (esp. ...)", "cat; feline") but NOT another word
               -- ("cat tongue"), 1 = the input appears mid-gloss.
               MAX(CASE
                     WHEN lower(gl.text) = lower(p_input) THEN 3
                     WHEN gl.text ~* ('^' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()') THEN 2
                     ELSE 1
                   END) AS match_rank,
               -- 1 if the input is a HEAD match (exact, or the gloss's head term —
               -- match_rank 3 or 2) in a CORE sense (the first two), else 0. Coarse
               -- on purpose: separates a core meaning (今/言葉/バット) from a
               -- peripheral one (此れ → "...; now" in a 4th sense; こと → "word" in a
               -- grammar note) WITHOUT over-ordering by exact-vs-clarified or sense
               -- index — so frequency decides among core matches (word→言葉, bat→バット).
               MAX(CASE WHEN s.position <= 1 AND (
                          lower(gl.text) = lower(p_input)
                          OR gl.text ~* ('^' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()')
                        ) THEN 1 ELSE 0 END) AS central
          FROM jmdict_senses s
          JOIN jmdict_glosses gl ON gl.sense_id = s.id
         WHERE gl.text ~* ('\y' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '\y')
         GROUP BY s.entry_id
      )
      SELECT
        pref.writing                                      AS translation,
        NULL::TEXT                                        AS input_reading,
        pref.reading                                      AS translation_reading,
        -- rank: head-match tier (exact OR gloss-head, i.e. match_rank ≥ 2, vs a
        -- mid-gloss mention) → a core-meaning match (now→今, not 此れ) → frequency
        -- (word→言葉 over 語; bat→バット over the rarer 打棒) → common flag. Collapsing
        -- exact (3) and clarified-head (2) into one tier lets the common バット
        -- ("bat (in baseball…)", rank 2) beat the rare 打棒 ("bat", rank 3).
        (ROW_NUMBER() OVER (ORDER BY (ent.match_rank >= 2) DESC, ent.central DESC,
                                     pref.frequency DESC NULLS LAST,
                                     pref.is_common DESC, ent.first_sense ASC))::INT - 1
                                                          AS sense_position,
        NULL::TEXT                                        AS writing,
        ent.entry_id                                      AS jmdict_entry_id,
        pref.frequency                                    AS frequency,
        -- POS of the entry's primary (position-0) sense.
        (SELECT sn.part_of_speech FROM jmdict_senses sn
          WHERE sn.entry_id = ent.entry_id ORDER BY sn.position ASC LIMIT 1)
                                                          AS part_of_speech
      FROM ent
      JOIN LATERAL (
        SELECT
          COALESCE(kj.text, ka.text)             AS writing,
          ka.text                                AS reading,
          COALESCE(kj.common, ka.common, FALSE)  AS is_common,
          -- frequency of the HEADWORD surface (preferred kanji, else kana) — not a
          -- max over all readings, so a shared kana can't inflate a rare kanji.
          COALESCE(kj.frequency, ka.frequency)   AS frequency
        FROM (SELECT kk.text, kk.common, kk.frequency FROM jmdict_kanji kk
               WHERE kk.entry_id = ent.entry_id
               ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
        FULL JOIN (SELECT nn.text, nn.common, nn.frequency FROM jmdict_kana nn
                    WHERE nn.entry_id = ent.entry_id
                    ORDER BY nn.common DESC, nn.position ASC LIMIT 1) ka ON TRUE
      ) pref ON TRUE
      WHERE pref.writing IS NOT NULL
      -- CAP the EN->JA result. Unlike JA->EN (one headword → its few real senses),
      -- this branch is a REVERSE gloss search: it returns every Japanese entry whose
      -- gloss mentions the word ("the" → 400+). The ORDER BY above already ranks the
      -- relevant ones first (head-match → core → frequency), so keep only the top
      -- slice — the long tail is noise (and an uncapped set ballooned the reader's
      -- per-word senses). sense_position is contiguous post-WHERE, so order by it.
      ORDER BY sense_position
      LIMIT 12;
  END IF;
END;
$$;

-- Only the service role (edge function) may call this; it reads the locked-down
-- jmdict_* tables. anon/authenticated are denied (they also lack table access).
REVOKE EXECUTE ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) TO service_role;

-- =========================
-- 3. service_role GRANTs
-- The edge function connects as service_role, which BYPASSES RLS but still needs
-- table-level GRANTs (RLS-bypass != privilege). Supabase's current default does
-- NOT auto-expose new tables to any API role, so grant explicitly:
--   * jmdict_* — SELECT (jmdict_lookup is SECURITY INVOKER, so it reads these as
--     the caller; clients still get nothing — they have no grant).
--   * words    — SELECT + INSERT + UPDATE (the find-or-create cache writes here).
-- This is the privilege gap that surfaced once the function actually queried the
-- DB (it was a throwing stub before). anon/authenticated grants live in their own
-- tables' migration; service_role is added here.
-- =========================
GRANT SELECT ON jmdict_entries, jmdict_kanji, jmdict_kana, jmdict_senses, jmdict_glosses
  TO service_role;
GRANT SELECT, INSERT, UPDATE ON words TO service_role;
