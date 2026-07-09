-- =========================================================
-- English word frequency (the DIFFICULTY axis for ENGLISH-source words).
--
-- Problem: `words.frequency` for an EN→JA row (an English word a learner studies)
-- was the matched JAPANESE entry's frequency (cat→猫 stored 猫's Zipf), because the
-- whole frequency pipeline is JMdict/JA-surface-keyed. So an English word's
-- difficulty used the wrong language's commonness.
--
-- Fix: a server-only reference table of ENGLISH surface → frequency (wordfreq Zipf
-- ×100, same scale as data/frequency/ja.tsv). The edge function, when projecting an
-- EN→JA lookup, overrides each row's frequency with the ENGLISH INPUT's own value
-- (english_frequency[lower(input)] ?? NULL) — never the JA translation's. This does
-- NOT touch EN→JA RESULT ORDERING (that's ranked inside jmdict_lookup's SQL, before
-- projection); it only fixes the stored frequency attribute that getDifficulty reads
-- for an English word. So it's low-risk (a stored-attribute correction, not a
-- ranking change).
--
-- Server-only, like jmdict_* / word_embeddings: RLS on, NO policies/grants — only
-- the edge function's service role reads it. Loaded by scripts/ingest-english-frequency.ts
-- from data/frequency/en.tsv (built by scripts/build-frequency.py en). CC-BY-SA
-- derived numbers, attributed in ATTRIBUTION.md (wordfreq).
-- =========================================================

CREATE TABLE IF NOT EXISTS english_frequency (
  surface   TEXT PRIMARY KEY,          -- lowercase English surface (NFC), matches wordfreq keys
  frequency INTEGER NOT NULL           -- wordfreq Zipf × 100 (higher = more common = easier)
);

-- Server-only: no policies, no grants → only the service role (edge function) reads it.
ALTER TABLE english_frequency ENABLE ROW LEVEL SECURITY;
