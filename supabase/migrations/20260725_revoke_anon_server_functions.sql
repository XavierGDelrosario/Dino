-- =========================================================
-- Harden the SERVER-ONLY functions: revoke client EXECUTE.
--
-- These functions are meant to be called ONLY by the edge function (service_role)
-- — the migrations that created them did `REVOKE EXECUTE … FROM PUBLIC`. But on
-- HOSTED Supabase that isn't enough: Supabase ships an
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated
-- so every new function ALSO gets an EXPLICIT grant to anon/authenticated, which
-- `REVOKE … FROM PUBLIC` does not remove. Net effect: on prod/staging a browser
-- client could call these directly (verified live). Local Supabase (CI) has no such
-- default grant, so the "is NOT callable by a client" integration specs passed there
-- but the leak was real on hosted. This revokes the explicit anon/authenticated
-- grants so hosted matches the intended lockdown (service_role keeps EXECUTE — the
-- edge is unaffected; internal callers run as service_role/owner).
--
-- Scope = OUR application functions only. Deliberately NOT touched:
--   · pgvector / pg_trgm EXTENSION functions (extension-managed; pure operators)
--   · delete_account() — the delete-account edge fn calls it with the USER's JWT
--   · client RPCs (create_custom_word, record_review, save_dictionary_word[s],
--     review_queue, related_words, is_admin, admin_*, confidence_from_stability)
--   · guard_user_deletion() — a trigger fn (fires without an EXECUTE grant)
--
-- CONVENTION going forward: a server-only function's migration must
--   REVOKE EXECUTE … FROM PUBLIC, anon, authenticated;  (not just PUBLIC)
-- because the Supabase default privilege re-grants anon/authenticated on CREATE.
-- =========================================================

DO $$
DECLARE
  fn TEXT;
  sigs TEXT[] := ARRAY[
    'jmdict_lookup(text, text, text)',
    'jmdict_lookup_many(text[], text, text)',
    'jmdict_entry_headword(text)',
    'wordnet_en_ja_lookup(text)',
    'wordnet_en_ja_lookup_many(text[])',
    'learn_words_at_band(text, text, smallint, text, integer, boolean)',
    'consume_translation_quota(text, integer, integer)',
    'consume_global_quota(integer, bigint)',
    'refund_translation_quota(text, integer)',
    'refund_global_quota(integer)',
    'prune_idempotency_keys()'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    -- Re-assert the intended grant (idempotent; the edge needs it).
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
