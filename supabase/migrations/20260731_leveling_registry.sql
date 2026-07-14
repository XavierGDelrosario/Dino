-- =========================================================
-- LEVELING REGISTRY + the SRS ease.
--
-- The scheduler (20260729) is level-BLIND: an N5 word an N3 user aces grows exactly
-- like an N1 word they ace, so beginner vocabulary keeps coming back. The ease is the
-- fix — but the level signal it needs is WEAK and LANGUAGE-SHAPED, which is what this
-- migration is really about. Measured over 7,523 JLPT-banded surfaces (full analysis +
-- reproducible queries in docs/research/Frequency_vs_Proficiency_by_POS.md):
--
--   · Corpus frequency vs the curated JLPT band: R² = 0.24, MAE 0.96 levels, and 14.7%
--     of words are ≥2 levels EASIER by frequency than JLPT says — the one direction
--     that can wrongly retire a word. But bands cover only 3.4% of the dictionary and
--     frequency covers 21.7%, so neither signal can be dropped for the other.
--   · The disagreement is POS-STRUCTURED, and the cause is mechanical: frequency is
--     per-SURFACE, and inflection splits a word's corpus mass across its forms.
--     Relative to the median frequency of its own JLPT band: affixes/counters +0.60
--     Zipf (never inflect → all the mass lands on one surface), verbs −0.76 (heavily
--     inflected → they look rarer than they are), nouns/adjectives/adverbs ±0.06.
--   · English is a DIFFERENT shape and can reuse none of it: far less inflection, no
--     counters, CEFR is 6 bands not 5 — and `words.part_of_speech` on an EN-source row
--     holds JMdict JAPANESE tags describing the translation, so there is no English POS
--     source at all today.
--
-- So: ONE language-agnostic calculator (srs_leveling below), and a per-language
-- PROFILE as reference DATA — measured, not hand-written (scripts/build-leveling-profile.ts).
--
-- Three rules the design turns on:
--   1. NEVER cross rulers. A word's position comes from its curated band OR from its
--      frequency; the user's comes from their band. Both are placed on ONE scale (the
--      corpus-frequency scale) via the band ANCHORS — each band's measured median
--      frequency — so the gap is a real distance, not an ordinal subtraction. This is
--      also what makes the non-uniform spacing correct for free: JLPT N5→N4 is 0.25
--      Zipf and N3→N2 is 0.64, while N2→N1 is 0.02 (N1 and N2 words are equally rare;
--      what separates them isn't frequency), and the anchors encode all of that.
--   2. CAP THE EASE BY SIGNAL QUALITY. A curated band earns the full cap (2.5×); raw
--      frequency, being ~24% predictive, earns a much smaller one (1.6×) — enough to
--      stretch an interval, never enough to retire a word outright.
--   3. CORRECT ONLY IN THE SAFE DIRECTION. The POS offset may make a word look HARDER
--      (rarer) than its raw frequency, never easier. Correcting verbs "toward" the band
--      (they read as too hard) would shift them easier and blew their risky rate from
--      0.9% to 15% when measured — the loss is asymmetric, so the correction must be.
--
-- NOT MATERIALIZED per word, on purpose: reviews read `words` directly in SQL and never
-- pass through the edge's projection path, so a stored level_position would go stale on
-- exactly the rows the scheduler cares about and could only be healed by the (deferred)
-- re-projection sweep. Computed at read time instead, so re-measuring a profile takes
-- effect immediately and retroactively — which matters, because these are parameters we
-- intend to FIT (see the review_log columns at the bottom).
--
-- A language with NO profile → ease 1.0 → today's behaviour. Nothing can be confidently
-- wrong for a language we have not measured.
-- =========================================================

-- ── The per-language profile (reference data; server-only, like jmdict_*) ──

-- Which POS group a tag belongs to, per language. The TAXONOMY is language-specific
-- (JMdict `v1`/`pref`/`ctr` for JA; Penn/UD tags for a future EN source), so it is DATA.
-- `priority` resolves a word carrying several tags (an entry tagged both `n` and `pref`
-- is an affix for our purposes — lowest number wins).
CREATE TABLE IF NOT EXISTS language_pos_group (
  language  TEXT    NOT NULL,
  pos_tag   TEXT    NOT NULL,
  pos_group TEXT    NOT NULL,
  priority  INT     NOT NULL,
  PRIMARY KEY (language, pos_tag)
);

-- How much a POS group's corpus frequency OVERSTATES its ease, in frequency units
-- (Zipf × 100 — the same units as words.frequency). Subtracted from the word's raw
-- frequency. MEASURED per language by scripts/build-leveling-profile.ts; must be >= 0
-- (rule 3: only ever make a word look harder).
CREATE TABLE IF NOT EXISTS language_pos_offset (
  language     TEXT NOT NULL,
  pos_group    TEXT NOT NULL,
  freq_offset  REAL NOT NULL CHECK (freq_offset >= 0),
  PRIMARY KEY (language, pos_group)
);

-- One row per language: where each proficiency band sits on the frequency scale, plus
-- the ease curve's slope and its two caps.
CREATE TABLE IF NOT EXISTS language_leveling (
  language           TEXT PRIMARY KEY,
  framework          TEXT,                 -- 'JLPT' | 'CEFR' … a snapshot: an old band
                                           --  can't silently mean something new later
  band_anchors       REAL[] NOT NULL,      -- band_anchors[b] = median frequency of band b
                                           --  (1 = easiest). Non-uniform spacing lives HERE.
  band_ease_cap      REAL NOT NULL DEFAULT 2.5,  -- ceiling when a CURATED band placed the word
  frequency_ease_cap REAL NOT NULL DEFAULT 1.6,  -- ceiling when only FREQUENCY placed it
  ease_per_unit      REAL NOT NULL DEFAULT 0.03, -- ease slope per frequency unit (Zipf×100),
                                                 --  i.e. +3.0 ease per Zipf. Calibrated so an
                                                 --  N5 word for an N3 user (0.51 Zipf apart)
                                                 --  reaches the 2.5 cap.
  measured_at        TIMESTAMPTZ
);

-- Server-only, exactly like jmdict_* / wordnet_*: RLS on, no policies, no grants. Only
-- the SECURITY DEFINER scheduler reads these.
ALTER TABLE language_pos_group  ENABLE ROW LEVEL SECURITY;
ALTER TABLE language_pos_offset ENABLE ROW LEVEL SECURITY;
ALTER TABLE language_leveling   ENABLE ROW LEVEL SECURITY;

-- The JMdict POS taxonomy (STATIC — it's the tag set, not a measurement, so it is seeded
-- here rather than by the script). Only groups we can measure need an offset row.
INSERT INTO language_pos_group (language, pos_tag, pos_group, priority) VALUES
  -- affixes / counters / bound morphemes: never inflect, so their frequency concentrates
  ('JA','pref','affix',1), ('JA','suf','affix',1), ('JA','n-suf','affix',1),
  ('JA','n-pref','affix',1), ('JA','ctr','affix',1),
  -- grammatical glue: excluded from the quiz already; kept here for completeness
  ('JA','prt','grammatical',2), ('JA','conj','grammatical',2), ('JA','aux','grammatical',2),
  ('JA','aux-v','grammatical',2), ('JA','aux-adj','grammatical',2), ('JA','cop','grammatical',2),
  ('JA','cop-da','grammatical',2), ('JA','int','grammatical',2), ('JA','exp','grammatical',2),
  ('JA','pn','grammatical',2),
  ('JA','adj-i','adjective',3), ('JA','adj-na','adjective',3), ('JA','adj-no','adjective',3),
  ('JA','adj-t','adjective',3), ('JA','adj-f','adjective',3), ('JA','adj-pn','adjective',3),
  ('JA','adv','adverb',4), ('JA','adv-to','adverb',4),
  -- verbs: heavily inflected, so their dictionary-form surface UNDERSTATES them
  ('JA','v1','verb',5), ('JA','v5u','verb',5), ('JA','v5k','verb',5), ('JA','v5g','verb',5),
  ('JA','v5s','verb',5), ('JA','v5t','verb',5), ('JA','v5n','verb',5), ('JA','v5b','verb',5),
  ('JA','v5m','verb',5), ('JA','v5r','verb',5), ('JA','v5k-s','verb',5), ('JA','v5u-s','verb',5),
  ('JA','v5aru','verb',5), ('JA','vk','verb',5), ('JA','vz','verb',5), ('JA','vs-i','verb',5),
  ('JA','vs-s','verb',5),
  ('JA','n','noun',6), ('JA','n-adv','noun',6), ('JA','n-t','noun',6)
ON CONFLICT (language, pos_tag) DO NOTHING;

-- ── The calculator: ONE implementation, no language branching ──────────────

-- The POS group of a word's tags (lowest priority number wins), or NULL.
CREATE OR REPLACE FUNCTION pos_group_of(p_language TEXT, p_pos TEXT[])
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT g.pos_group
    FROM language_pos_group g
   WHERE g.language = p_language
     AND g.pos_tag = ANY(COALESCE(p_pos, '{}'))
   ORDER BY g.priority
   LIMIT 1;
$$;

-- What the scheduler needs to know about (user, word), and what it logs.
DROP TYPE IF EXISTS srs_leveling_t CASCADE;
CREATE TYPE srs_leveling_t AS (
  word_position REAL,   -- the word, on the frequency scale (Zipf×100)
  user_position REAL,   -- the user, on the SAME scale (their band's anchor)
  level_source  TEXT,   -- 'band' | 'frequency' — which signal placed the word (and its cap)
  ease          REAL    -- 1.0 … cap. 1.0 means "no evidence this is below you"
);

-- Resolve the ease for (user, dictionary sense). Returns ease 1.0 — today's behaviour —
-- whenever ANY input is missing: no profile for the language, no band for the user, no
-- level data on the word, a custom word (no dictionary sense), or a word whose language
-- is not the one the user's band was measured in (their band is a JLPT/CEFR ordinal and
-- means nothing against another language's scale).
CREATE OR REPLACE FUNCTION srs_leveling(p_user_id TEXT, p_dictionary_word_id UUID)
RETURNS srs_leveling_t
LANGUAGE sql
STABLE
AS $$
  WITH w AS (
    SELECT source_lang, proficiency_band, difficulty_override, frequency, part_of_speech
      FROM words WHERE word_id = p_dictionary_word_id
  ), u AS (
    SELECT COALESCE(proficiency_band, level)::INT AS band, learning_language
      FROM users WHERE user_id = p_user_id
  ), p AS (
    SELECT * FROM language_leveling WHERE language = (SELECT source_lang FROM w)
  ), pos AS (
    SELECT COALESCE(
             (SELECT o.freq_offset
                FROM language_pos_offset o
               WHERE o.language  = (SELECT source_lang FROM w)
                 AND o.pos_group = pos_group_of((SELECT source_lang FROM w),
                                                (SELECT part_of_speech FROM w))),
             0)::REAL AS freq_offset
  ), placed AS (
    SELECT
      -- The word: a curated band wins (it's a human's judgement of learner level);
      -- otherwise its POS-corrected corpus frequency.
      CASE
        WHEN COALESCE(w.difficulty_override, w.proficiency_band) IS NOT NULL
             AND COALESCE(w.difficulty_override, w.proficiency_band)
                 BETWEEN 1 AND cardinality(p.band_anchors)
          THEN p.band_anchors[COALESCE(w.difficulty_override, w.proficiency_band)]
        WHEN w.frequency IS NOT NULL
          THEN w.frequency - pos.freq_offset
      END AS word_position,
      CASE
        WHEN COALESCE(w.difficulty_override, w.proficiency_band) IS NOT NULL
             AND COALESCE(w.difficulty_override, w.proficiency_band)
                 BETWEEN 1 AND cardinality(p.band_anchors)
          THEN 'band' ELSE 'frequency'
      END AS level_source,
      -- The user: their band's anchor puts them on the same frequency scale.
      CASE WHEN u.band BETWEEN 1 AND cardinality(p.band_anchors)
           THEN p.band_anchors[u.band] END AS user_position,
      p.band_ease_cap, p.frequency_ease_cap, p.ease_per_unit
      FROM w, u, p, pos
     -- The band was measured in the user's LEARNING language; it means nothing against
     -- another language's scale. NULL learning_language (a guest on the app default) is
     -- not evidence of a mismatch, so it passes.
     WHERE u.learning_language IS NULL OR u.learning_language = w.source_lang
  )
  SELECT COALESCE(
    (SELECT ROW(
       word_position,
       user_position,
       level_source,
       -- gap > 0 ⇒ the word is MORE COMMON than the user's own threshold ⇒ below them.
       LEAST(
         CASE WHEN level_source = 'band' THEN band_ease_cap ELSE frequency_ease_cap END,
         GREATEST(1.0, 1 + ease_per_unit * (word_position - user_position))
       )
     )::srs_leveling_t
       FROM placed
      WHERE word_position IS NOT NULL AND user_position IS NOT NULL),
    ROW(NULL, NULL, NULL, 1.0)::srs_leveling_t
  );
$$;

REVOKE EXECUTE ON FUNCTION pos_group_of(TEXT, TEXT[])   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION srs_leveling(TEXT, UUID)     FROM PUBLIC;
-- No client grant: only record_review (SECURITY DEFINER) calls these.

-- ── review_log: record WHY the schedule moved ──────────────────────────────
-- The schedule now depends on the ease (and, before it, on a random fuzz draw), so the
-- log was no longer self-describing: you could not reconstruct why a stability changed.
-- These columns make it so — and they are what will let us FIT the ease curve against
-- real recall (does a word 0.5 Zipf below you actually get recalled better, and by how
-- much?) instead of against a wordlist. review_log is append-only and CANNOT be
-- backfilled, so they land BEFORE the ease starts using them. Nullable: rows written
-- before this migration, and words with no leveling data, simply have none.
ALTER TABLE review_log ADD COLUMN IF NOT EXISTS ease           REAL;
ALTER TABLE review_log ADD COLUMN IF NOT EXISTS word_position  REAL;
ALTER TABLE review_log ADD COLUMN IF NOT EXISTS user_position  REAL;
ALTER TABLE review_log ADD COLUMN IF NOT EXISTS level_source   TEXT;
ALTER TABLE review_log ADD COLUMN IF NOT EXISTS retrievability REAL;

-- ── record_review: apply the ease ──────────────────────────────────────────
-- Body swap (supersedes 20260729). Everything else — the fuzz, the absolute lapse cap,
-- the cram freeze, the ownership guard, the confidence bucketing — is unchanged.
CREATE OR REPLACE FUNCTION record_review(
  p_user_word_id UUID,
  p_grade        INT
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w         user_words;
  v_now     TIMESTAMPTZ := now();
  v_elapsed REAL;
  v_r       REAL;
  v_prev_s  REAL;
  v_base_s  REAL;
  v_new_s   REAL;
  v_lvl     srs_leveling_t;
  c_max_stability CONSTANT REAL := 3650;
  c_fresh_r       CONSTANT REAL := 0.9;
BEGIN
  IF p_grade < 1 OR p_grade > 5 THEN
    RAISE EXCEPTION 'invalid grade % (expected 1-5)', p_grade;
  END IF;

  SELECT * INTO w FROM user_words
   WHERE user_word_id = p_user_word_id
     AND user_id = (auth.uid())::text
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_word % not found', p_user_word_id;
  END IF;

  v_prev_s := w.stability;
  v_lvl    := srs_leveling(w.user_id, w.dictionary_word_id);  -- ease 1.0 when unknown

  IF w.stability IS NULL OR w.last_reviewed_date IS NULL THEN
    -- First-ever review: seed so confidence_from_stability(seed) == grade. The ease is
    -- applied HERE only at grade 5 — a grade-4 seed × ease would cross into the 5/5
    -- bucket and read back as a grade the user never gave. Grade 4 gets its ease on the
    -- NEXT review (the growth below).
    v_elapsed := NULL;
    v_r       := NULL;
    v_base_s  := CASE p_grade
                   WHEN 1 THEN 1.5
                   WHEN 2 THEN 4.0
                   WHEN 3 THEN 10.0
                   WHEN 4 THEN 22.0
                   WHEN 5 THEN 40.0 * v_lvl.ease
                 END;
  ELSE
    v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.last_reviewed_date)) / 86400.0);
    v_r := exp(- v_elapsed / GREATEST(w.stability, 0.01));

    -- CRAM FREEZE (20260729): a successful review of a word still held teaches the
    -- scheduler nothing. Logged, but neither the strength nor the clock moves.
    IF p_grade >= 3 AND v_r > c_fresh_r THEN
      INSERT INTO review_log
        (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
         ease, word_position, user_position, level_source, retrievability)
      VALUES
        (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, w.stability,
         v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r);
      RETURN w;
    END IF;

    IF p_grade <= 2 THEN
      -- LAPSE — no ease. Forgetting a word that "should" be easy for you is exactly the
      -- case where the level estimate was wrong; it must come back regardless. This is
      -- what makes the retirement above a bet that can be called in.
      v_base_s := LEAST(
                    w.stability * (CASE p_grade WHEN 1 THEN 0.3 ELSE 0.6 END),
                    CASE p_grade WHEN 1 THEN 2.0 ELSE 5.0 END
                  );
    ELSE
      -- Recalled after a real gap: grow. (1 - R) is the spacing effect; the ease is how
      -- far BELOW the user the word sits. Grade 3 ("shaky") gets NO ease — not mastered.
      v_base_s := w.stability * (1 + (CASE p_grade
                                        WHEN 3 THEN 1.0
                                        WHEN 4 THEN 2.0 * v_lvl.ease
                                        WHEN 5 THEN 3.5 * v_lvl.ease
                                      END) * (1 - v_r));
    END IF;
  END IF;

  v_base_s := LEAST(c_max_stability, GREATEST(0.5, v_base_s));
  v_new_s  := LEAST(c_max_stability, GREATEST(0.5, fuzz_stability(v_base_s, 0.15)));

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         confidence_rating  = confidence_from_stability(v_base_s)
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  INSERT INTO review_log
    (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
     ease, word_position, user_position, level_source, retrievability)
  VALUES
    (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s,
     v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r);

  RETURN w;
END;
$$;
