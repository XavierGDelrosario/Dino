-- =========================================================
-- EN→JA: give the WordNet path the same headline test the gloss path already has.
--
-- 20260742 fixed EN→JA ordering by ranking on HOW PRIMARY the match is inside the
-- entry (`headline_rank`) instead of on Japanese corpus frequency — but it fixed
-- `jmdict_lookup` only. `wordnet_en_ja_lookup` LEADS the merge (it is the primary
-- provider; the gloss search only fills remaining slots), and it still ordered by
-- `rank, frequency`. So the fix was largely MASKED in production: the gloss path was
-- right and the user never saw it.
--
-- MEASURED on prod 2026-08-01, top-1 over a 30-word list:
--     before  17/30      after  28/30      11 fixed, 0 regressions
--   run   → 言う (say)        → 走る        eat  → 使う (use)   → 食べる
--   see   → 思う (think)      → 見る        go   → なる (become)→ 行く
--   cat   → やつ (guy)        → 猫          hand → 方 (direction) → 手
--   light → 好き (like)       → 光          table→ 料理 (cooking) → テーブル
--   read  → 言う              → 読む        write→ 作る          → 書く
--   love  → 思う              → 愛
--
-- WHY `rank` COULD NOT DO IT. `ja.rank` is MIN(sense_rank) over the matched synsets,
-- so EVERY lemma touching the English word's top synset collapses to 0 — dozens of
-- them. The tie then fell to `frequency DESC`, and Japanese corpus frequency answers
-- "which Japanese word is common", never "which Japanese word means this English
-- word": 言う (568) beat 走る (446). Measured for "run", 走る was not in the returned
-- 12 AT ALL. Same failure 20260742 documented, same fix.
--
-- WHAT WAS REJECTED, and why it is recorded here: ordering by the number of matched
-- synsets a lemma appears in, by specificity (hits/total synsets), or by the JMdict
-- `common` flag. All were measured — best of them reached 23/30, and every one
-- REGRESSED basics that already worked (dog → ドック, bank → バンク, spring → 泉,
-- buy → 買収, friend → 仲間). A change that breaks `dog → 犬` is not an improvement.
-- Do not re-try these without re-measuring the whole list.
--
-- `headline_rank` here mirrors 20260742's exactly. 9 = the English word appears in
-- NONE of the entry's glosses, which is the genuinely WordNet-only case (linked
-- semantically, not lexically) — those still rank, just below anything the
-- dictionary itself confirms. WordNet's own sense order is kept as the tiebreak
-- WITHIN a headline tier, so synset grouping still does its job.
-- =========================================================

CREATE OR REPLACE FUNCTION wordnet_en_ja_lookup(p_input TEXT)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,   -- always NULL for EN->JA (mirrors jmdict_lookup)
  jmdict_entry_id      TEXT,
  frequency            INT,
  proficiency_band     SMALLINT,   -- added by 20260716 / 20260740; NOT in 20260703
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
           hw.writing, hw.reading, hw.is_common, hw.frequency,
           hw.proficiency_band, hw.part_of_speech
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
  headline AS (
    -- HOW PRIMARY the English word is inside each candidate entry — identical to
    -- jmdict_lookup's (20260742):
    --   0 = first gloss of the first sense — the entry MEANS this word
    --   1 = first sense, later gloss
    --   2 = a later sense
    -- (absent → 9 below: WordNet linked it semantically and the dictionary does not
    -- confirm it lexically.) Restricted to the entries WordNet actually produced, so
    -- this is a handful of id lookups, not the full gloss scan jmdict_lookup runs.
    SELECT s.entry_id,
           MIN(CASE
                 WHEN (lower(gl.text) = lower(p_input) OR lower(gl.text) = 'to ' || lower(p_input))
                   OR gl.text ~* ('^(to )?' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()')
                 THEN (CASE WHEN s.position = 0 AND gl.position = 0 THEN 0
                            WHEN s.position = 0 THEN 1
                            ELSE 2 END)
                 ELSE 9
               END) AS headline_rank
      FROM jmdict_senses s
      JOIN jmdict_glosses gl ON gl.sense_id = s.id
     WHERE s.entry_id IN (SELECT entry_id FROM resolved)
     GROUP BY s.entry_id
  ),
  dedup AS (
    -- one row per entry (a synset's lemmas, or a lemma's homographs, can collide
    -- on the same entry); keep the best-ranked occurrence.
    SELECT DISTINCT ON (r.entry_id)
           r.entry_id, r.rank, r.writing, r.reading,
           r.is_common, r.frequency, r.proficiency_band, r.part_of_speech,
           COALESCE(h.headline_rank, 9) AS headline_rank
      FROM resolved r
      LEFT JOIN headline h ON h.entry_id = r.entry_id
     WHERE r.writing IS NOT NULL
     ORDER BY r.entry_id, r.rank ASC NULLS LAST, r.frequency DESC NULLS LAST
  )
  SELECT
    d.writing                                                   AS translation,
    NULL::TEXT                                                  AS input_reading,
    d.reading                                                   AS translation_reading,
    -- contiguous rank: match QUALITY first (does this entry mean the word, and how
    -- primarily), then WordNet's sense order, then corpus frequency as the tiebreak
    -- among equals — the same discipline JA→EN and jmdict_lookup follow.
    (ROW_NUMBER() OVER (ORDER BY d.headline_rank ASC,
                                 d.rank ASC NULLS LAST,
                                 d.frequency DESC NULLS LAST,
                                 d.is_common DESC))::INT - 1     AS sense_position,
    NULL::TEXT                                                  AS writing,
    d.entry_id                                                  AS jmdict_entry_id,
    d.frequency                                                 AS frequency,
    d.proficiency_band                                          AS proficiency_band,
    d.part_of_speech                                            AS part_of_speech
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$$;

REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) TO service_role;
