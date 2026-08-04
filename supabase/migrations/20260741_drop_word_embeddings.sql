-- =========================================================
-- Drop the word map (embeddings) — a STORAGE decision, reversible by design.
--
-- WHY. `word_embeddings` is 80 MB of a 500 MB free tier (prod was at 434 MB, 87%
-- full). It powered exactly one feature — "Explore related words", and the #12
-- domain-expansion quiz built on the same RPC — which is being removed with it.
-- Nothing else in the app reads it: the DIFFICULTY axis is frequency/proficiency
-- and never touched embeddings (they are separate axes on purpose).
--
-- The feature was also underperforming in a documented way: with the small model
-- (multilingual-e5-small, 384-dim) katakana loanwords cluster by SPELLING rather
-- than meaning — ストライカー returns ストリーカー and ストリッパー while the genuinely
-- related ピッチャー ranks last. The fix was a 1024-dim model, which roughly TRIPLES
-- vector storage and is precisely what would have forced a paid tier. Removing the
-- feature removes that pressure instead of paying for it.
--
-- HOW IT COMES BACK. Nothing about the pipeline is deleted:
--   · scripts/build-embeddings.py still generates the vectors;
--   · the original migration that CREATED this table and related_words() is still
--     in this directory (history is forward-only — that file is not edited);
--   · re-applying that migration and re-running the script restores the feature.
-- What would have to be rewritten is the client half (services/embeddings.ts,
-- services/domain.ts and the Explore button), removed in the same commit — recover
-- it from git history rather than retyping it.
--
-- WORTH RECONSIDERING FIRST if this is ever revisited: CLAUDE.md notes that an LLM
-- prompted with "write a paragraph at level X using these seed words" collapses
-- #11 and #12 into one API call — no vectors, no storage, ongoing per-use cost.
-- That may be the better implementation of the same product idea.
-- =========================================================

-- The RPC first: it reads the table, so dropping it afterwards would leave a
-- function that errors at call time rather than one that is simply absent.
DROP FUNCTION IF EXISTS related_words(TEXT, INT, INT);
DROP FUNCTION IF EXISTS related_words(TEXT, INT);
DROP FUNCTION IF EXISTS related_words(TEXT);

DROP TABLE IF EXISTS word_embeddings;

-- NOTE: the `vector` extension is deliberately LEFT INSTALLED. It costs no
-- meaningful storage, and dropping it would make restoring this (or any future
-- pgvector work) a privileged operation again.
