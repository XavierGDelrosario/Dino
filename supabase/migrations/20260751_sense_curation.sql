-- =========================================================
-- Sense curation, part 2: pin a reading, and reorder senses by hand.
--
-- Two columns, both authored, both answering a limitation the first batch of the
-- corpus (20260750) ran straight into.
--
-- ── 1. example_reading — pin the target's furigana ──────────────────────────────
-- Two of the three senses withdrawn from the corpus were withdrawn for one reason:
-- kuromoji picks the reading and the corpus cannot overrule it.
--   · 辛い reads つらい in EVERY context tried, including 「このカレーはとても辛い」, so a
--     sentence meaning "spicy" would print つらい furigana — and 辛い→からい/つらい is the
--     flagship homograph this whole feature exists to disambiguate.
--   · 金 never reads かね: 「金がかかる」→ きん (gold), 「金がなくて…」→ きむ (the surname Kim).
-- Neither is a bad sentence. Both are correct Japanese that the ANALYZER reads wrong,
-- and no rewrite fixes them, because IPADIC has no context in which it picks the other
-- reading. So the corpus states the reading: `example_reading` is how the TARGET word is
-- pronounced IN THIS SENTENCE, and it overrules the analyzer where they disagree.
--
-- This is the same authority order the app already uses everywhere else (CLAUDE.md,
-- "Dictionary stack"): the verified dictionary reading beats kuromoji's guess. The one
-- new thing is that it now applies inside an example sentence.
--
-- ── 2. sense_rank — a curated display order ─────────────────────────────────────
-- JA→EN senses are shown in JMdict's own order, which sometimes leads with something
-- nobody wants: 橋 opens on "pons Varolii" (a brain structure) and 粉 on "decimetre"
-- (docs/QualityLimitations.md §2). The primary sense is not cosmetic — it is the meaning
-- shown first, and the one "Add" saves by default.
--
-- ‼️ THE ORDER CANNOT BE FIXED BY RENUMBERING. `jmdict_sense_pos` is half of
-- `dictionary_ref` (`<entry>:<sense>`), the cache's identity key and what a saved
-- `user_words` row effectively pins to. Renumbering a sense would repoint or orphan
-- every saved word on it. So ordering moves to its OWN column: `words.sense_rank`,
-- which every read sorts by, and which defaults to jmdict_sense_pos so nothing changes
-- until a sense is deliberately curated. Identity stays put; only the display moves.
--
-- Both columns are JA→EN only, for the reason the first migration gives: in the EN→JA
-- direction jmdict_sense_pos is a match rank across entries, not a sense index, so
-- there is nothing to key curation on.
-- =========================================================

SET LOCAL lock_timeout = '3s';

-- The authored side. Curation lives beside the example because it is the same act by
-- the same author on the same (entry, sense) — one file, one ingest, one review.
ALTER TABLE jmdict_sense_example
  ADD COLUMN IF NOT EXISTS example_reading TEXT
    CHECK (example_reading IS NULL OR btrim(example_reading) <> ''),
  ADD COLUMN IF NOT EXISTS sense_rank INT
    CHECK (sense_rank IS NULL OR sense_rank >= 0);

-- A reading with no sentence to annotate is a mistake, not a partial state.
ALTER TABLE jmdict_sense_example
  DROP CONSTRAINT IF EXISTS sense_example_reading_needs_example;
ALTER TABLE jmdict_sense_example
  ADD CONSTRAINT sense_example_reading_needs_example
    CHECK (example_reading IS NULL OR example IS NOT NULL);

-- 20260750's "a row must annotate something" now has a third way to be satisfied.
-- Reordering is a legitimate curation ON ITS OWN: 橋 splits into two entries and the
-- one meaning "pons Varolii" (a brain structure) can outrank the one meaning "bridge"
-- purely on entry id. Demoting it needs a rank and nothing else — no sentence is owed
-- for a sense whose only problem is where it sits in the list.
ALTER TABLE jmdict_sense_example
  DROP CONSTRAINT IF EXISTS sense_example_has_content;
ALTER TABLE jmdict_sense_example
  ADD CONSTRAINT sense_example_has_content
    CHECK (example IS NOT NULL OR definition_ja IS NOT NULL OR sense_rank IS NOT NULL);

-- The 20260750 lockdown lesson: Supabase's default privileges re-grant on ALTER in some
-- paths, so re-state it rather than assume it held.
REVOKE ALL ON TABLE jmdict_sense_example FROM PUBLIC, anon, authenticated;

-- The projection target.
ALTER TABLE words
  ADD COLUMN IF NOT EXISTS example_reading TEXT,
  ADD COLUMN IF NOT EXISTS sense_rank INT;

-- ‼️ BACKFILL IS REQUIRED, not cosmetic. Once reads ORDER BY sense_rank, a NULL would
-- sort every un-curated row into one undifferentiated clump and destroy the sense order
-- of the entire cache. Seeding it to jmdict_sense_pos makes the new column exactly
-- equivalent to the old ordering on day one — curation then moves individual senses off
-- that default, and nothing else changes. Cheap: `words` is ~7.8k rows on prod.
UPDATE words SET sense_rank = jmdict_sense_pos WHERE sense_rank IS NULL;

-- Reads sort on this, so it is worth an index for the same reason jmdict_sense_pos was
-- worth ordering on: it is in the ORDER BY of every cache read.
CREATE INDEX IF NOT EXISTS idx_words_sense_rank ON words (dictionary_ref, sense_rank);

COMMENT ON COLUMN words.example_reading IS
  'How the target word is pronounced in words.example — overrules kuromoji where they disagree.';
COMMENT ON COLUMN words.sense_rank IS
  'Display order for a headword''s senses. Defaults to jmdict_sense_pos; curated overrides move a sense without touching dictionary_ref identity.';
