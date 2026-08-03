-- =========================================================
-- Sense enrichment — an example sentence + a Japanese definition, PER SENSE.
--
-- WHY PER SENSE, not per word. A gloss list cannot separate 辛い からい ("spicy") from
-- 辛い つらい ("painful") — the two read identically on the page and a learner picking
-- between them has only the English to go on. A sentence can: 「このカレーは辛い」 vs
-- 「練習が辛い」 settles it in one line. This buys sense precision without needing
-- per-sense frequency or per-sense embeddings (see docs/QualityLimitations.md §2,
-- "Everything is per-SURFACE or per-ENTRY, never per-SENSE").
--
-- AUTHORED DATA, GENERATED AT INGEST — the opposite of a runtime LLM feature. The
-- corpus is a committed file (data/sense_examples/ja.tsv) loaded by
-- scripts/ingest-sense-examples.ts, so there is no per-user cost, no quota, no
-- ANTHROPIC_API_KEY edge secret, and every sentence is reviewable in a diff. It
-- REMOVES a planned paid feature rather than adding one (docs/TODO.md, "Sense
-- enrichment").
--
-- ‼️ NO FOREIGN KEY to jmdict_entries, deliberately. scripts/ingest-jmdict.ts is
-- truncate-and-reload, so an FK would either block a re-ingest or cascade it into
-- deleting hand-written sentences that took hours to produce. This table OUTLIVES the
-- dictionary it annotates: a re-ingest replaces JMdict, and these rows re-attach by
-- (entry_id, sense_pos) afterwards. The cost is that a row can dangle if JMdict ever
-- renumbers a sense — visible as coverage loss, never as data loss.
--
-- ‼️ JA→EN ONLY, and the key is why. `words.jmdict_sense_pos` means two different
-- things by direction: for JA→EN it is the entry's true sense index (`s.position` in
-- jmdict_lookup), but for EN→JA it is a MATCH RANK across entries
-- (20260742_en_ja_headline_rank.sql — a ROW_NUMBER over the ranking, one row per
-- ENTRY). Joining an EN→JA row on it would staple sentence #0's example onto whatever
-- entry happened to rank first. So the edge applies these to JA→EN rows only. Making
-- EN→JA exact means returning jmdict_lookup's internal `first_sense`; until then, an
-- EN→JA row simply carries NULL here, which the UI already treats as "no example".
--
-- Server-only (RLS on, no policies, no grants) — same lockdown as jmdict_* /
-- english_frequency. Only the edge's service role reads it, and it reaches users
-- exclusively through the `words` projection below.
-- =========================================================

CREATE TABLE IF NOT EXISTS jmdict_sense_example (
  -- JMdict ent_seq + the sense's own position (0 = primary). No FK; see the header.
  jmdict_entry_id  TEXT NOT NULL,
  jmdict_sense_pos INT  NOT NULL CHECK (jmdict_sense_pos >= 0),

  -- A Japanese sentence demonstrating THIS sense, and its English translation. The
  -- sentence renders through ParagraphReader, so every word in it is knowledge-
  -- coloured, tappable and addable — which is why it must survive the kuromoji gate
  -- (scripts/validate-sense-examples.ts) before it is allowed into the file.
  example       TEXT CHECK (example       IS NULL OR btrim(example)       <> ''),
  example_gloss TEXT CHECK (example_gloss IS NULL OR btrim(example_gloss) <> ''),

  -- A monolingual Japanese definition, written as a real JA dictionary would — NOT
  -- simplified. It carries what an English gloss structurally cannot: collocation,
  -- negation habits, what an auxiliary attaches to (遜色 glossed "inferiority" invites
  -- the unnatural 遜色がある; the definition says 多くは「ない」を伴って使う).
  definition_ja TEXT CHECK (definition_ja IS NULL OR btrim(definition_ja) <> ''),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (jmdict_entry_id, jmdict_sense_pos),

  -- A row that annotates nothing is a bug in the generator, not a valid absence:
  -- absence is expressed by having no row at all.
  CONSTRAINT sense_example_has_content
    CHECK (example IS NOT NULL OR definition_ja IS NOT NULL),

  -- A translation with nothing to translate. The reverse IS allowed — an example may
  -- ship before its gloss is written.
  CONSTRAINT sense_example_gloss_needs_example
    CHECK (example_gloss IS NULL OR example IS NOT NULL)
);

ALTER TABLE jmdict_sense_example ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- The projection target on `words`.
--
-- Same shape as english_frequency → words.frequency (20260721): a server-only
-- reference table that the edge folds onto the cached row at projection time. The
-- client never joins the source table — it reads `words`, which it can already see.
--
-- Nullable and NOT part of any identity key: these are attributes of the sense, so
-- they must not participate in `UNIQUE (dictionary_ref, source_lang, target_lang)`.
--
-- ‼️ ONE statement, under a lock_timeout — this is a live table with users on it.
-- ADD COLUMN with no default is metadata-only on PG11+, so the WORK is instant, but it
-- still needs a brief ACCESS EXCLUSIVE lock on `words`. That is the classic way an
-- "instant" migration becomes an outage: if the ALTER has to queue behind one
-- long-running read, every query that arrives after it queues behind the ALTER, and
-- reads stall for as long as that first query runs. lock_timeout turns a stall into a
-- migration that fails fast and can simply be re-run; three separate ALTERs would take
-- (and risk) the lock three times, so they are combined into one.
-- =========================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE words
  ADD COLUMN IF NOT EXISTS example       TEXT,
  ADD COLUMN IF NOT EXISTS example_gloss TEXT,
  ADD COLUMN IF NOT EXISTS definition_ja TEXT;

COMMENT ON COLUMN words.example IS
  'Japanese sentence demonstrating THIS sense (projected from jmdict_sense_example; JA→EN rows only).';
COMMENT ON COLUMN words.example_gloss IS
  'English translation of words.example. NULL when the example has no gloss yet.';
COMMENT ON COLUMN words.definition_ja IS
  'Monolingual Japanese definition of THIS sense (projected from jmdict_sense_example).';
