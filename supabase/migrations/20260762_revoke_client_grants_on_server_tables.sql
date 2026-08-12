-- =========================================================
-- Close the hosted anon/authenticated TABLE-grant leak — the table-level twin of
-- 20260748's function-level one.
--
-- THE MECHANISM, same as 20260748. On HOSTED Supabase there is an
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated
-- so every newly CREATED table gets EXPLICIT anon/authenticated privileges. A migration
-- that simply never writes a GRANT does NOT end up with "no grants" — it ends up with
-- whatever the hosted default handed out. 20260746 found this for english_frequency /
-- english_proficiency and fixed those two by hand; the same hole was left open on every
-- other server-only table.
--
-- MEASURED on prod 2026-08-12 — 14 tables with RLS on, ZERO policies, and anon SELECT +
-- authenticated INSERT/UPDATE granted:
--   account_deletion_log · global_translation_usage · idempotency_keys · jmdict_entries ·
--   jmdict_glosses · jmdict_kana · jmdict_kanji · jmdict_senses · language_leveling ·
--   language_pos_group · language_pos_offset · wordnet_senses_en · wordnet_synsets ·
--   wordnet_words_ja
-- …plus four tables whose POLICIES are narrower than their GRANTS: review_log (read-own
-- SELECT policy, but INSERT/UPDATE/DELETE granted), words, user_limits, translation_usage.
--
-- ‼️ NOTHING LEAKED AND NOTHING WAS FORGEABLE. RLS is enabled on all of them, and a table
-- with RLS and no policy returns no rows and accepts no writes whatever the grants say.
-- This is defence in depth, not an incident: it removes the second thing that would have
-- to go wrong (someone adding a permissive policy, or disabling RLS on a table believed
-- to be grant-protected) before data moved.
--
-- HOW IT WAS FOUND, and the more useful half: the RLS integration spec asserts a client
-- read ERRORS. It does — locally, where there is no default-privileges grant, so the read
-- is refused with 42501. Against the hosted projects the identical read returns EMPTY WITH
-- NO ERROR, because the grant exists and RLS filters instead. 9 tests failed that way the
-- first time the suite was ever pointed at a hosted project. The suite was right and the
-- environment it had always run in was the lenient one.
--
-- WHY REVOKE IS SAFE HERE, per group:
--   · the 14 zero-policy tables — no client operation can succeed on them today (RLS, no
--     policy), so removing the grant cannot change client behaviour. Only the edge
--     function's service_role touches them, and service_role keeps its grants.
--   · review_log — CLAUDE.md: "written ONLY by record_review()", which is SECURITY DEFINER
--     and therefore runs as the owner, needing no caller grant. SELECT is KEPT (the
--     read-own policy is real and the app reads its own history).
--   · words — invariant #2: "clients cannot insert/update/delete words at all". SELECT kept.
--   · user_limits / translation_usage — both documented read-own, no client write ("a
--     client can't raise its own cap", "can't fake/reset usage"). SELECT kept.
--
-- service_role is untouched throughout: it is what the edge function runs as.
-- =========================================================

-- ── 1. Server-only tables: no client role has any business here at all ──────────
REVOKE ALL ON
  account_deletion_log,
  global_translation_usage,
  idempotency_keys,
  jmdict_entries,
  jmdict_glosses,
  jmdict_kana,
  jmdict_kanji,
  jmdict_senses,
  language_leveling,
  language_pos_group,
  language_pos_offset,
  wordnet_senses_en,
  wordnet_synsets,
  wordnet_words_ja
FROM anon, authenticated;

-- ── 2. Read-own / read-only tables: keep SELECT, drop every write ───────────────
-- The policies already say read-only; this makes the GRANT layer say it too.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  review_log,
  words,
  user_limits,
  translation_usage
FROM anon, authenticated;

-- ── 3. Re-assert the service_role grants the edge function depends on ──────────
-- REVOKE ALL above targets only anon/authenticated, so these are unchanged in practice;
-- stated explicitly so a future reader can see the intended end state in one place
-- (and so a re-run after any grant drift restores it).
GRANT SELECT ON
  jmdict_entries, jmdict_glosses, jmdict_kana, jmdict_kanji, jmdict_senses,
  wordnet_senses_en, wordnet_synsets, wordnet_words_ja,
  language_leveling, language_pos_group, language_pos_offset
TO service_role;

GRANT SELECT, INSERT, UPDATE ON
  global_translation_usage, idempotency_keys, account_deletion_log, translation_usage
TO service_role;
