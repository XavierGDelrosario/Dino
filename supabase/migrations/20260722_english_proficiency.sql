-- =========================================================
-- English CEFR proficiency band (the curated LEVEL label for ENGLISH-source words).
--
-- Mirror of english_frequency (20260721), but for the PROFICIENCY axis. `words.
-- proficiency_band` for an EN→JA row was the matched JAPANESE entry's JLPT band (wrong
-- framework, wrong word); it should be the ENGLISH input's CEFR band. So: a server-only
-- reference table of English surface → CEFR band (A1→1 … C2→6), and the edge overrides
-- each EN→JA row's proficiency_band with the English input's own value on projection.
--
-- In the leveling model (getDifficulty = override ?? proficiency ?? frequency) the CEFR
-- band LEADS over frequency, so this also improves English difficulty, not just the label.
-- Does NOT change EN→JA ordering (ranked in jmdict_lookup's SQL first) — a stored-attribute
-- correction only.
--
-- Server-only (RLS on, no policies/grants — only the edge's service role reads it).
-- Loaded by scripts/ingest-english-proficiency.ts from data/proficiency/en.tsv (built by
-- scripts/build-proficiency-cefr.py from CEFR-J + Octanove). Attributed in ATTRIBUTION.md.
-- =========================================================

CREATE TABLE IF NOT EXISTS english_proficiency (
  surface TEXT PRIMARY KEY,     -- lowercase English surface (NFC), matches the edge's lower(input)
  band    SMALLINT NOT NULL CHECK (band BETWEEN 1 AND 6)   -- CEFR A1→1 … C2→6 (ascending = harder)
);

-- Server-only: no policies, no grants → only the service role (edge function) reads it.
ALTER TABLE english_proficiency ENABLE ROW LEVEL SECURITY;
