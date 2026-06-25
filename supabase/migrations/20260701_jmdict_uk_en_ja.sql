-- =========================================================
-- Fix: EN->JA lookup must honor "usually kana" (uk), like the JA->EN branch does.
-- The EN->JA branch picked COALESCE(kanji, kana) as the Japanese headword, so uk
-- words surfaced their rare/archaic kanji ("this" -> 此れ instead of これ; similarly
-- する / できる / etc.). Apply the same uk rule as JA->EN: uk entries headline as
-- the KANA, and a kana headword carries no furigana (translation_reading NULL),
-- with frequency taken from the kana surface.
--
-- Forward-only CREATE OR REPLACE of jmdict_lookup (full body re-stated below; only
-- the EN->JA `pref` LATERAL's writing/reading/frequency selection changed). The
-- `words` cache is projected lazily, so new lookups pick this up immediately; the
-- cache is empty (purged) so no re-projection sweep is needed.
-- =========================================================

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
          -- "usually kana" (uk): headline as the KANA, not the (often rare) kanji —
          -- mirrors the JA->EN branch so "this" -> これ (not 此れ), する, できる, etc.
          CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END AS writing,
          -- a kana headword needs no furigana; a kanji headword reads as its kana.
          CASE WHEN uk.is_uk THEN NULL ELSE ka.text END                       AS reading,
          COALESCE(kj.common, ka.common, FALSE)  AS is_common,
          -- frequency of the HEADWORD surface (kana for uk, else preferred kanji
          -- then kana) — not a max over all readings, so a shared kana can't inflate
          -- a rare kanji.
          CASE WHEN uk.is_uk THEN ka.frequency
               ELSE COALESCE(kj.frequency, ka.frequency) END                  AS frequency
        FROM (SELECT kk.text, kk.common, kk.frequency FROM jmdict_kanji kk
               WHERE kk.entry_id = ent.entry_id
               ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
        FULL JOIN (SELECT nn.text, nn.common, nn.frequency FROM jmdict_kana nn
                    WHERE nn.entry_id = ent.entry_id
                    ORDER BY nn.common DESC, nn.position ASC LIMIT 1) ka ON TRUE
        -- uk = the PRIMARY (position-0) sense tagged "usually kana" for this entry.
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                            WHERE sn.entry_id = ent.entry_id
                            ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
        ) uk
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
