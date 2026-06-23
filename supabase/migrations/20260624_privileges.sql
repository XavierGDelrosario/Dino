-- =========================================================
-- Privilege hardening — least-privilege DELETE (docs/Production_Hardening.md §1b).
--
-- Dictionary / JMdict source / embeddings / usage+limits are mutated ONLY by the
-- ingest scripts (run as the DB owner) — NO client OR service-role DELETE; the
-- only "deletion" is a controlled re-ingest. Core user data is deletable ONLY by
-- its owner (RLS self-service); service_role gets no broad DELETE, so a leaked
-- service key / rogue admin can't mass-erase. The ONE sanctioned full-account
-- erasure (GDPR right-to-erasure / abandoned-guest cleanup) is delete_account(),
-- scoped to the caller and audited. review_log stays delete-locked except via the
-- users cascade on a real account deletion (append-only FSRS history otherwise).
--
-- NOTE: delete_account() erases this app's PUBLIC-schema data. Removing the
-- Supabase auth.users row pairs with real auth (#13) via the admin API — out of
-- scope for the DB layer.
-- =========================================================

-- 1. Dictionary, JMdict source, embeddings, usage/limits: no client/service DELETE.
--    Idempotent (most already lack it) — this makes the lock explicit + durable
--    against any future blanket re-grant.
REVOKE DELETE ON words, word_embeddings, translation_usage, user_limits
  FROM anon, authenticated, service_role;
REVOKE DELETE ON jmdict_entries, jmdict_kanji, jmdict_kana, jmdict_senses, jmdict_glosses
  FROM anon, authenticated, service_role;

-- 2. Core user data: keep the owner's RLS-scoped self-service DELETE (anon /
--    authenticated on user_words/lists/list_words); deny service_role the broad
--    path. users + review_log are not client-deletable at all.
REVOKE DELETE ON user_words, lists, list_words, review_log, users FROM service_role;

-- 3. The single sanctioned account-erasure path. SECURITY DEFINER so it deletes
--    despite the REVOKEs above, but scoped to the CALLER (auth.uid()) — a user can
--    only erase THEMSELVES — and audited. Deleting the users row cascades
--    user_words / lists / list_words / review_log / user_limits / translation_usage.
CREATE TABLE IF NOT EXISTS account_deletion_log (
  user_id    TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE account_deletion_log ENABLE ROW LEVEL SECURITY; -- server-only: no client policies
-- admins (service_role) may READ the audit; no one writes it via PostgREST.
GRANT SELECT ON account_deletion_log TO service_role;

CREATE OR REPLACE FUNCTION delete_account()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid TEXT := (auth.uid())::text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  INSERT INTO account_deletion_log (user_id) VALUES (v_uid);
  DELETE FROM users WHERE user_id = v_uid; -- cascades all of the caller's own data
END;
$$;

REVOKE EXECUTE ON FUNCTION delete_account() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION delete_account() TO anon, authenticated;
