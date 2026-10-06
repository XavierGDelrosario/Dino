-- =========================================================
-- EN→JA ranking: Princeton WordNet sense order as a DEMOTE-ONLY signal.
--
-- `wordnet_senses_en.sense_rank` was 0 on every row since the ingest (the Japanese
-- WordNet ships no ranks), so the "WordNet's own sense order" tiebreak 20260747
-- reserved was inert and headline frequency carried the order alone (measured 28/30
-- top-1). scripts/apply-wordnet-sense-ranks.ts now fills the column from Princeton's
-- index.sense (1 = the lemma's most frequent sense by SemCor tag counts; run it after
-- every wordnet_* re-ingest).
--
-- MEASURED BEFORE USING IT (staging, 2026-10-06, 30 common polysemous words): putting
-- the rank AHEAD of frequency, as 20260747 wrote it, regressed the top meaning on 5 —
-- bank → 岸 over 銀行, break → 途切れ, match → マッチ (the matchstick), point → 指す,
-- charge → 突撃 — and improved none. Princeton's order is per lemma per POS, so a
-- verb's first sense competes with a noun's, and SemCor's counts are not a learner's
-- expectations. Used only to DEMOTE senses past the lemma's 5th, frequency still
-- ordering within each half, it changed 5 of 30 — see → 見送る, dog → 爪, run's 伝線
-- fall out of the top three; 駆ける and 遊ぶ move up — and regressed nothing. A cut at
-- the 3rd sense changed 8 and started touching top meanings (point → ポイント over
-- 先), so 5 it is. Re-measure the whole list before moving the threshold.
--
-- The function body is the LIVE definition (pg_get_functiondef on staging, identical
-- on prod — both at 20260793) with only the ORDER BY changed, so it carries every
-- column later migrations added rather than 20260747's older shape.
-- =========================================================

CREATE OR REPLACE FUNCTION public.wordnet_en_ja_lookup(p_input text)
 RETURNS TABLE(translation text, input_reading text, translation_reading text, sense_position integer, writing text, jmdict_entry_id text, frequency integer, proficiency_band smallint, part_of_speech text[], definition_en text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH syn AS (
    -- synsets for the English lemma (lowercased; input is NFC-normalized upstream),
    -- carrying the synset's English part of speech (n/v/a/r) AND its English
    -- definition. definition_en is in the GROUP BY explicitly: it is functionally
    -- dependent on the synset PK, but the group key here is se.synset_id and Postgres
    -- does not infer the dependency across the join.
    SELECT se.synset_id, MIN(se.sense_rank) AS rank, sy.pos, sy.definition_en
      FROM wordnet_senses_en se
      JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
     WHERE se.lemma = lower(btrim(p_input))
     GROUP BY se.synset_id, sy.pos, sy.definition_en
  ),
  ja AS (
    -- Japanese lemmas across those synsets; best (lowest) sense_rank per lemma, and the
    -- POS *and DEFINITION* of the synset that WON — a lemma reachable from both a noun
    -- and a verb synset takes the sense the ranking actually picked, not an arbitrary
    -- one. This is what makes the definition describe THIS row's translation.
    SELECT DISTINCT ON (wj.lemma) wj.lemma, syn.rank, syn.pos, syn.definition_en
      FROM wordnet_words_ja wj
      JOIN syn ON syn.synset_id = wj.synset_id
     ORDER BY wj.lemma, syn.rank ASC NULLS LAST
  ),
  resolved AS (
    -- resolve each JA lemma to its single best JMdict entry, then its headword.
    SELECT e.entry_id, ja.rank, ja.pos AS en_pos, ja.definition_en AS en_definition,
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
           r.entry_id, r.rank, r.en_pos, r.en_definition, r.writing, r.reading,
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
    -- A READING IDENTICAL TO ITS OWN TERM IS NOT A READING (header §2): every katakana
    -- loanword headwords as its own kana, and コンピューター(コンピューター) is noise.
    NULLIF(d.reading, d.writing)                                AS translation_reading,
    -- contiguous rank: match QUALITY first (does this entry mean the word, and how
    -- primarily), then WordNet's sense order, then corpus frequency as the tiebreak
    -- among equals — the same discipline JA→EN and jmdict_lookup follow.
    (ROW_NUMBER() OVER (ORDER BY d.headline_rank ASC,
                                 -- Princeton sense order, DEMOTE-ONLY: a sense past the
                                 -- lemma's 5th ranks below the rest; within each half,
                                 -- corpus frequency decides as before (see header).
                                 (CASE WHEN d.rank IS NULL OR d.rank <= 5 THEN 0 ELSE 1 END) ASC,
                                 d.frequency DESC NULLS LAST,
                                 d.rank ASC NULLS LAST,
                                 d.is_common DESC))::INT - 1     AS sense_position,
    NULL::TEXT                                                  AS writing,
    d.entry_id                                                  AS jmdict_entry_id,
    d.frequency                                                 AS frequency,
    d.proficiency_band                                          AS proficiency_band,
    -- THE ENGLISH word's part of speech, not the Japanese translation's (20260760).
    CASE WHEN d.en_pos IS NULL THEN NULL ELSE ARRAY[d.en_pos] END AS part_of_speech,
    -- ...and the English DEFINITION of that same winning synset, so the POS and the
    -- definition always describe one sense rather than two.
    d.en_definition                                             AS definition_en
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$function$;
