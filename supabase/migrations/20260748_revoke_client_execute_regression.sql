-- =========================================================
-- Re-close the hosted anon/authenticated EXECUTE leak on two server-only functions.
--
-- 20260725 found and fixed this class: on HOSTED Supabase there is an
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated
-- so every newly CREATED function gets an EXPLICIT anon/authenticated grant, which
-- `REVOKE EXECUTE … FROM PUBLIC` does NOT remove. It set the convention:
--
--     a server-only function's migration must
--     REVOKE EXECUTE … FROM PUBLIC, anon, authenticated;   (not just PUBLIC)
--
-- The convention has not held. Every migration since that DROPs and re-CREATEs one of
-- these functions silently re-acquires the grants, and two did:
--   · learn_words_at_band  — re-created by 20260730, and again by 20260745
--   · srs_leveling         — created by 20260731
-- Found by auditing prod ACLs after pushing 20260745; verified live, not inferred.
--
-- WHY IT MATTERS. Both are SECURITY DEFINER and both take a `p_user_id` the caller
-- supplies, so a browser client could call them for ANOTHER user's id:
--   · learn_words_at_band(..., p_user_id, ..., p_exclude_seen) — diffing the result
--     with exclude_seen true/false infers which words that user has saved.
--   · srs_leveling(p_user_id, ...) — returns that user's level position/ease.
-- Neither is reachable from our client (the edge calls learn_words_at_band as
-- service_role; record_review calls srs_leveling and is itself SECURITY DEFINER), so
-- revoking changes no app behaviour.
--
-- ‼️ DELIBERATELY NOT REVOKED — display_confidence and fuzz_stability, which the same
-- audit also found granted to anon/authenticated. They are NOT leaks and revoking them
-- WOULD BREAK THE APP FOR EVERY USER:
--   · review_queue is SECURITY INVOKER and calls display_confidence
--   · save_dictionary_word / save_dictionary_words are SECURITY INVOKER and call
--     fuzz_stability
-- An INVOKER function runs as the CALLING role, so `authenticated` genuinely needs
-- EXECUTE on both. Both are pure math over caller-supplied arguments — they read no
-- table and take no user id — so exposure leaks nothing. This mirrors 20260725's own
-- exclusion of confidence_from_stability. Do not "tidy" these away; check prosecdef
-- of the callers first.
-- =========================================================

REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN)
  TO service_role;

REVOKE EXECUTE ON FUNCTION srs_leveling(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION srs_leveling(TEXT, UUID) TO service_role;
