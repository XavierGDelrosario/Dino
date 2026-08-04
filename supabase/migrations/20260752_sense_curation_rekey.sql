-- =========================================================
-- Re-key sense curation onto `dictionary_ref`, and drop the language from the schema.
--
-- WHY, measured on prod before writing this. Of 22 cached EN→JA primaries — the meaning
-- shown first and the one "Add" saves — roughly a third are wrong or poor:
--   changes → 嫦娥 (Chang'e, the Chinese moon goddess) · I → 一 (the number one) ·
--   Before → かつて · have → とる · fine → 罰金 · expensive → 高価 ·
--   if → と · don't → な · is → ある   (English function words landing on JA particles)
-- Against that, a full QA pass over the Japanese corpus found 68 of 68 senses correctly
-- ordered, with one demotion needed (橋 → "pons Varolii"). The asymmetry is structural,
-- not luck: JA→EN order is JMdict's EDITORIAL sense order, written by lexicographers.
-- EN→JA order is a HEURISTIC we compute per query (gloss match + WordNet merge +
-- 20260742's headline rank). The side that needs curation most was the side 20260751
-- could not reach.
--
-- ‼️ JMdict'S ORDERING IS NOT BEING DROPPED. `words.sense_rank` is still seeded from
-- `jmdict_sense_pos`, so an un-curated JA→EN sense sits exactly where JMdict put it, and
-- curation stays exception-only (1 row in 73). For EN→JA there is no JMdict order to
-- drop — JMdict has no opinion on whether `changes` is 変化 or 嫦娥. Curating that
-- direction overrides OUR heuristic, not the dictionary.
--
-- WHY dictionary_ref IS THE RIGHT KEY. It is what `words` itself is unique on, and it is
-- stable in BOTH directions:
--   JA→EN  <entryId>:<sensePos>  — so JMdict's sense position is still inside the key
--   EN→JA  <input>:<entryId>     — "for the English word X, the Japanese entry Y"
-- The old key (jmdict_entry_id, jmdict_sense_pos) could not express the second: in that
-- direction jmdict_sense_pos is the ranker's OUTPUT, so curating it would pin a position
-- the ranker recomputes, and any ranking change would silently void every curation.
--
-- Case-folded, because the EN→JA ref embeds the typed search term: `Car:1323080` and
-- `car:1323080` are the same lookup (53 of 284 EN→JA rows sit on a capitalized input).
-- Folding the CURATION key alone fixes it without touching cache identity, which
-- `user_words` and the projection upsert both depend on.
--
-- AND IT REMOVES THE LANGUAGE FROM THE SCHEMA. No jmdict_entry_id in the key, so the
-- table is no longer JMdict-shaped and another language's source plugs in unchanged;
-- `definition_ja` becomes `definition_source` (the definition is in the SOURCE language —
-- Japanese for JA→EN, English for the mirror-image EN→JA feature).
--
-- Done NOW, at 73 curated senses and 38 English words, because this is the cheapest it
-- will ever be — CLAUDE.md's own rule: data-model decisions first, cheap before real
-- users have saved data, painful after.
-- =========================================================

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS sense_curation (
  -- words.dictionary_ref, LOWERCASED (see curationKeyFor in _lib.ts).
  dictionary_ref TEXT NOT NULL CHECK (btrim(dictionary_ref) <> ''),
  -- Part of the key exactly as it is in words' own UNIQUE: the same ref means different
  -- things per direction, and a language pair is what disambiguates it.
  source_lang    TEXT NOT NULL CHECK (btrim(source_lang) <> ''),
  target_lang    TEXT NOT NULL CHECK (btrim(target_lang) <> ''),

  example         TEXT CHECK (example         IS NULL OR btrim(example)         <> ''),
  example_gloss   TEXT CHECK (example_gloss   IS NULL OR btrim(example_gloss)   <> ''),
  -- Renamed from definition_ja: a definition in the SOURCE language, whatever that is.
  definition_source TEXT CHECK (definition_source IS NULL OR btrim(definition_source) <> ''),
  example_reading TEXT CHECK (example_reading IS NULL OR btrim(example_reading) <> ''),
  sense_rank      INT  CHECK (sense_rank IS NULL OR sense_rank >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (dictionary_ref, source_lang, target_lang),

  CONSTRAINT curation_has_content
    CHECK (example IS NOT NULL OR definition_source IS NOT NULL OR sense_rank IS NOT NULL),
  CONSTRAINT curation_gloss_needs_example
    CHECK (example_gloss IS NULL OR example IS NOT NULL),
  CONSTRAINT curation_reading_needs_example
    CHECK (example_reading IS NULL OR example IS NOT NULL)
);

ALTER TABLE sense_curation ENABLE ROW LEVEL SECURITY;
-- Stated, not inherited (the 20260750 lesson: Supabase default privileges grant new
-- public-schema tables to anon/authenticated, and TRUNCATE is not gated by RLS).
REVOKE ALL ON TABLE sense_curation FROM PUBLIC, anon, authenticated;

-- Carry the 73 authored senses across. Every existing row is JA→EN, and its ref is
-- <entry>:<sense> by construction — the same string the projection builds.
INSERT INTO sense_curation
  (dictionary_ref, source_lang, target_lang, example, example_gloss, definition_source,
   example_reading, sense_rank)
SELECT lower(e.jmdict_entry_id || ':' || e.jmdict_sense_pos), 'JA', 'EN',
       e.example, e.example_gloss, e.definition_ja, e.example_reading, e.sense_rank
  FROM jmdict_sense_example e
ON CONFLICT (dictionary_ref, source_lang, target_lang) DO NOTHING;

DROP TABLE IF EXISTS jmdict_sense_example;

-- The projection column follows the rename. The DATA is already correct — this is a
-- name change, so the 62 enriched rows keep their definitions.
ALTER TABLE words RENAME COLUMN definition_ja TO definition_source;

COMMENT ON COLUMN words.definition_source IS
  'Monolingual definition of this sense IN THE SOURCE LANGUAGE (projected from sense_curation).';
COMMENT ON TABLE sense_curation IS
  'Authored per-sense curation keyed on words.dictionary_ref (lowercased) + language pair: example sentence, gloss, source-language definition, pinned reading, display rank.';
