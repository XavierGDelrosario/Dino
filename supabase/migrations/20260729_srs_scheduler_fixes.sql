-- =========================================================
-- SRS scheduler fixes: FUZZ · ABSOLUTE LAPSE CAP · CRAM FREEZE · QUEUE JITTER.
--
-- Three observed problems, all in how `stability` is written. None of them are
-- language-specific — this migration is pure memory model. (The LEVEL-aware ease
-- — "an N5 word an N3 user aces should leave the rotation" — is deliberately NOT
-- here: it depends on per-language leveling data whose accuracy we measured at
-- R² ≈ 0.24 against JLPT, so it needs its own registry + its own migration.)
--
-- (1) COHORT SYNCHRONIZATION — "everything decays at once". Every stability write
--     was DETERMINISTIC, so words written together (the placement quiz mass-adds
--     hundreds at a flat 40d seed in ONE call, at ONE instant) shared an identical
--     R = exp(-Δ/S) curve and came due on the SAME day, forever. A 20-card session
--     then drains that one cohort for weeks; a word you just graded 3 sits at high
--     R right after its review, BEHIND the whole cohort, so sessions look like
--     nothing but confidence 4/5 cards.
--     FIX: fuzz_stability() — every stability written is multiplied by a random
--     factor, so a cohort's due dates spread out permanently instead of moving in
--     lockstep. This is FSRS's "fuzz". It is the ONLY nondeterminism in the
--     scheduler (one function, so it can be tuned or disabled in one place) and it
--     is LOAD-BEARING — do not "clean it up".
--
-- (2) A LAPSE ON A MATURE WORD DIDN'T BRING IT BACK. The lapse was purely
--     multiplicative (S × 0.3), which is toothless at long stabilities: a word at
--     600 days that you FORGET would be rescheduled at 180 days, still reading
--     5/5. FIX: the cut is capped in ABSOLUTE days — grade 1 → ≤ 2 days, grade 2 →
--     ≤ 5 days. You forgot it; it comes back in the next session or two, however
--     mature it was.
--
-- (3) CRAMMING INFLATED THE SCHEDULE. Re-testing a word you just saw grew its
--     stability anyway: measured, 14 days of daily grade-5 reviews took a word
--     from 40d to ~85d, after which the model claimed R = 0.84 at a two-week gap —
--     a 14-day retention claim from a learner who only ever demonstrated ONE-day
--     intervals (the massed-practice illusion). The (1-R) spacing factor damps this
--     but does not stop it.
--     FIX: a SUCCESSFUL review of a word that is still fresh (R > 0.9) is LOGGED
--     but changes nothing — not the stability, and NOT last_reviewed_date. (Both
--     matter: resetting the decay clock alone would push the next review further
--     out for free.) Practise as much as you like; the schedule is driven by spaced
--     recall, not by repetition. A LAPSE is exempt — failing a word you saw
--     yesterday is real evidence and still cuts you to ≤ 2 days. So is a
--     freshly-lapsed word (small S → low R → not fresh), which is what lets daily
--     study still rehabilitate the words you are actually failing.
--
-- The decay SHAPE (R = exp(-Δ/S)) is unchanged; services/review.ts's
-- retrievability() still mirrors it. What changed is how S is written.
-- =========================================================

-- ── The one source of scheduling nondeterminism ────────────────────────────

-- Spread a stability by ±p_spread (uniform), so two words written with the SAME
-- strength at the SAME moment do NOT come due on the same day. NULL passes through
-- (a cold word stays cold). Applied to every stability write: a graded review
-- (±15%, enough to break lockstep without muddying the ranking) and the cold-start
-- SEED (±35% — the placement quiz writes hundreds of identical seeds at once, so
-- that cohort needs the widest spread: 40d ± 14d ≈ a month of scatter).
CREATE OR REPLACE FUNCTION fuzz_stability(p_stability REAL, p_spread REAL DEFAULT 0.15)
RETURNS REAL
LANGUAGE sql
VOLATILE
AS $$
  SELECT CASE
           WHEN p_stability IS NULL THEN NULL
           ELSE (p_stability * ((1 - p_spread) + 2 * p_spread * random()))::REAL
         END;
$$;
REVOKE EXECUTE ON FUNCTION fuzz_stability(REAL, REAL) FROM PUBLIC;
-- save_dictionary_word(s) are SECURITY INVOKER, so the CALLER needs EXECUTE.
GRANT  EXECUTE ON FUNCTION fuzz_stability(REAL, REAL) TO anon, authenticated;

-- ── record_review: lapse cap + cram freeze + fuzz ──────────────────────────
-- Body swap only (supersedes 20260713); the {user_word_id, grade} contract, the
-- review_log append, the ownership guard and the confidence bucketing are unchanged.
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
  v_base_s  REAL;   -- the scheduler's answer, BEFORE fuzz
  v_new_s   REAL;   -- what is stored: fuzzed + clamped
  -- A word can't be scheduled further out than this (~10y) — the growth is
  -- multiplicative, so an unbounded S would eventually overflow the REAL.
  c_max_stability CONSTANT REAL := 3650;
  -- Above this recall probability the word is still FRESH: a successful review of it
  -- is cramming, and teaches us nothing about long-term retention (see header (3)).
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

  IF w.stability IS NULL OR w.last_reviewed_date IS NULL THEN
    -- First-ever review: seed strength so confidence_from_stability(seed) == grade
    -- (rate 5 → 5/5; rate 1 → 1/5). See the buckets in confidence_from_stability().
    v_elapsed := NULL;
    v_r       := NULL;
    v_base_s  := CASE p_grade
                   WHEN 1 THEN 1.5    -- bucket [1,3)   → 1
                   WHEN 2 THEN 4.0    -- bucket [3,7)   → 2
                   WHEN 3 THEN 10.0   -- bucket [7,16)  → 3
                   WHEN 4 THEN 22.0   -- bucket [16,35) → 4
                   WHEN 5 THEN 40.0   -- bucket [35,∞)  → 5
                 END;
  ELSE
    v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.last_reviewed_date)) / 86400.0);
    -- R = exp(-Δ/S); mirrors retrievability() in services/review.ts.
    v_r := exp(- v_elapsed / GREATEST(w.stability, 0.01));

    -- CRAM FREEZE: recalling a word you still hold (R > 0.9) is not evidence of
    -- durable memory. Log it, change NOTHING — not the strength, not the clock —
    -- and return the row as-is. A LAPSE skips this branch on purpose.
    IF p_grade >= 3 AND v_r > c_fresh_r THEN
      INSERT INTO review_log
        (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability)
      VALUES
        (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, w.stability);
      RETURN w;
    END IF;

    IF p_grade <= 2 THEN
      -- LAPSE — you forgot it, so it comes back SOON, however mature it was. The cut
      -- is capped in ABSOLUTE days, not merely scaled: 0.3 × 600d is still half a
      -- year for a word the user just told us they'd forgotten. The caps land in the
      -- matching confidence bucket, so the grade the user gave is the confidence they
      -- read back: 1 → ≤2d (bucket 1), 2 → ≤5d (bucket 2).
      v_base_s := LEAST(
                    w.stability * (CASE p_grade WHEN 1 THEN 0.3 ELSE 0.6 END),
                    CASE p_grade WHEN 1 THEN 2.0 ELSE 5.0 END
                  );
    ELSE
      -- Recalled after a real gap: grow. (1 - R) is the SPACING EFFECT — recalling
      -- something you'd nearly forgotten earns far more than re-reviewing something
      -- still fresh (which the freeze above now rejects outright).
      v_base_s := w.stability * (1 + (CASE p_grade
                                        WHEN 3 THEN 1.0
                                        WHEN 4 THEN 2.0
                                        WHEN 5 THEN 3.5
                                      END) * (1 - v_r));
    END IF;
  END IF;

  -- Fuzz, then clamp. The stored SCHEDULE is the fuzzed strength; the displayed
  -- CONFIDENCE bucket is derived from the UN-fuzzed one — otherwise the jitter could
  -- drag a value across a bucket edge (a first grade-5 seeds 40d, and 40 × 0.85 = 34
  -- would read back as 4/5, contradicting the grade the user just gave, which the
  -- 20260713 seeds exist to prevent). The two differ by at most the fuzz; nothing
  -- compares them.
  v_base_s := LEAST(c_max_stability, GREATEST(0.5, v_base_s));
  v_new_s  := LEAST(c_max_stability, GREATEST(0.5, fuzz_stability(v_base_s, 0.15)));

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         confidence_rating  = confidence_from_stability(v_base_s)
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  INSERT INTO review_log
    (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability)
  VALUES
    (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s);

  RETURN w;
END;
$$;

-- ── The cold-start SEED path: the WIDE fuzz ────────────────────────────────
-- p_initial_stability is the caller's seed (services/calibration seedStability, or
-- the placement quiz's flat "I know this word" 40d). Fuzzing it here is what stops
-- the quiz's mass-add from becoming a mass-review months later — this ONE call
-- writes hundreds of rows with an identical strength at an identical instant.
CREATE OR REPLACE FUNCTION save_dictionary_word(
  p_user_id            TEXT,
  p_dictionary_word_id UUID,
  p_list_id            UUID DEFAULT NULL,
  p_initial_stability  REAL DEFAULT NULL   -- seed; NULL = cold start
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  d     words;
  v_row user_words;
BEGIN
  SELECT * INTO d FROM words
   WHERE word_id = p_dictionary_word_id AND is_verified = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dictionary word % not found', p_dictionary_word_id;
  END IF;

  -- A NEW row is seeded (NULL → cold start). On CONFLICT the DO UPDATE touches ONLY
  -- input, so an existing row keeps its earned review history.
  --
  -- SCHEDULE from the fuzzed seed, CONFIDENCE from the un-fuzzed one — same split as
  -- record_review: the quiz's "I know this" seed (40d) must read back as 5/5, and
  -- 40 × 0.65 would fall out of that bucket.
  INSERT INTO user_words
    (user_id, input, source_lang, target_lang, dictionary_word_id, custom_translation,
     stability, confidence_rating)
  VALUES
    (p_user_id, d.input, d.source_lang, d.target_lang, p_dictionary_word_id, NULL,
     fuzz_stability(p_initial_stability, 0.35), confidence_from_stability(p_initial_stability))
  ON CONFLICT (user_id, dictionary_word_id) DO UPDATE
    SET input = EXCLUDED.input
  RETURNING * INTO v_row;

  IF p_list_id IS NOT NULL THEN
    INSERT INTO list_words (list_id, user_word_id)
    VALUES (p_list_id, v_row.user_word_id)
    ON CONFLICT (list_id, user_word_id) DO NOTHING;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION save_dictionary_words(
  p_user_id             TEXT,
  p_dictionary_word_ids UUID[],
  p_list_id             UUID DEFAULT NULL,
  p_initial_stabilities REAL[] DEFAULT NULL  -- seeds aligned to the ids (NULL = all cold)
)
RETURNS SETOF user_words
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_rows user_words[];
  v_stabs REAL[] := COALESCE(
    p_initial_stabilities,
    array_fill(NULL::real, ARRAY[COALESCE(array_length(p_dictionary_word_ids, 1), 0)])
  );
BEGIN
  -- This is the call the placement quiz makes with every word it just added — the
  -- single most important place for the fuzz to land. Schedule = fuzzed seed,
  -- confidence = un-fuzzed seed (see save_dictionary_word).
  WITH ins AS (
    INSERT INTO user_words
      (user_id, input, source_lang, target_lang, dictionary_word_id, custom_translation,
       stability, confidence_rating)
    SELECT p_user_id, w.input, w.source_lang, w.target_lang, w.word_id, NULL,
           fuzz_stability(pair.stab, 0.35), confidence_from_stability(pair.stab)
      FROM unnest(p_dictionary_word_ids, v_stabs) AS pair(wid, stab)
      JOIN words w ON w.word_id = pair.wid AND w.is_verified = TRUE
    ON CONFLICT (user_id, dictionary_word_id) DO UPDATE
      SET input = EXCLUDED.input      -- existing rows keep their stability
    RETURNING *
  )
  SELECT array_agg(ins) INTO v_rows FROM ins;

  IF p_list_id IS NOT NULL AND v_rows IS NOT NULL THEN
    INSERT INTO list_words (list_id, user_word_id)
    SELECT p_list_id, r.user_word_id FROM unnest(v_rows) AS r
    ON CONFLICT (list_id, user_word_id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT * FROM unnest(COALESCE(v_rows, '{}'::user_words[]));
END;
$$;

-- ── review_queue: rank by OVERDUE-NESS, with a jittered tie-break ──────────
-- Same set, same ordering PRINCIPLE (most-forgotten first) — but ranked on
-- urgency = Δdays / stability instead of R = exp(-urgency). The two are monotone
-- (exp is), so the order is identical; urgency is just the space where a
-- multiplicative jitter is meaningful (R saturates at ~0, where ±15% of ~1e-9 is
-- nothing, so an identical cohort would keep coming back in the SAME block).
-- ±15% here means consecutive sessions draw a different slice of a tied cohort
-- rather than replaying it. `retrievability` is still returned for display.
-- VOLATILE (was STABLE): random() per row, per call.
CREATE OR REPLACE FUNCTION review_queue(
  p_user_id       TEXT,
  p_limit         INT,
  p_list_id       UUID    DEFAULT NULL,
  p_user_word_ids UUID[]  DEFAULT NULL
)
RETURNS TABLE (
  user_word_id               UUID,
  user_id                    TEXT,
  input                      TEXT,
  source_lang                TEXT,
  target_lang                TEXT,
  dictionary_word_id         UUID,
  custom_translation         TEXT,
  translation                TEXT,
  input_reading              TEXT,
  translation_reading        TEXT,
  proficiency_band           SMALLINT,
  part_of_speech             TEXT[],
  frequency                  INT,
  stability                  REAL,
  confidence_rating          INT,
  last_reviewed_date         TIMESTAMPTZ,
  originally_translated_date TIMESTAMPTZ,
  retrievability             REAL
)
LANGUAGE sql
VOLATILE
AS $$
  SELECT
    uw.user_word_id,
    uw.user_id,
    uw.input,
    uw.source_lang,
    uw.target_lang,
    uw.dictionary_word_id,
    uw.custom_translation,
    COALESCE(uw.custom_translation, w.translation, '')                          AS translation,
    w.input_reading                                                             AS input_reading,
    CASE WHEN uw.custom_translation IS NOT NULL THEN NULL ELSE w.translation_reading END
                                                                                AS translation_reading,
    w.proficiency_band                                                          AS proficiency_band,
    w.part_of_speech                                                            AS part_of_speech,
    w.frequency                                                                 AS frequency,
    uw.stability,
    uw.confidence_rating,
    uw.last_reviewed_date,
    uw.originally_translated_date,
    (CASE
       WHEN uw.stability IS NULL OR uw.stability <= 0 THEN 0
       ELSE exp( - GREATEST(0, EXTRACT(EPOCH FROM
                   (now() - COALESCE(uw.last_reviewed_date, uw.originally_translated_date))) / 86400.0)
                 / uw.stability )
     END)::REAL                                                                 AS retrievability
  FROM user_words uw
  LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
  WHERE uw.user_id = p_user_id
    AND (p_list_id IS NULL OR EXISTS (
          SELECT 1 FROM list_words lw
           WHERE lw.user_word_id = uw.user_word_id
             AND lw.list_id = p_list_id))
    AND (p_user_word_ids IS NULL OR uw.user_word_id = ANY(p_user_word_ids))
  ORDER BY
    -- A cold word (no stability) is infinitely overdue → always first; the jitter
    -- only shuffles it against other cold words.
    (CASE
       WHEN uw.stability IS NULL OR uw.stability <= 0 THEN 1e9
       ELSE GREATEST(0, EXTRACT(EPOCH FROM
              (now() - COALESCE(uw.last_reviewed_date, uw.originally_translated_date))) / 86400.0)
            / uw.stability
     END) * (0.85 + 0.30 * random()) DESC,
    COALESCE(uw.last_reviewed_date, uw.originally_translated_date, 'epoch'::timestamptz) ASC
  LIMIT GREATEST(0, p_limit);
$$;
REVOKE EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) TO anon, authenticated;
