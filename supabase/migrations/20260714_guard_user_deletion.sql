-- =========================================================
-- Guard against casual / accidental user deletion (esp. the bulk variety).
--
-- Context: a direct `postgres` superuser connection can wipe users with a one-line
-- `DELETE FROM public.users` / `auth.users` — exactly how 25 prod guests were
-- removed in one shot. Deleting a `public.users` row CASCADES all of that user's
-- vocabulary / lists / reviews (it is the root of the per-user FK tree); deleting
-- `auth.users` removes the login. Neither should be a frictionless default.
--
-- This adds a BEFORE DELETE trigger on both tables that REFUSES the delete unless
-- it comes through a sanctioned path:
--   1. An explicit, deliberate override set in the SAME transaction:
--        SET LOCAL dino.allow_user_deletion = 'on';
--      (intended for an audited admin cleanup script — you have to mean it).
--   2. Supabase's own auth admin role (`supabase_auth_admin`), so real
--      single-account erasure via the edge `delete-account` function
--      (auth.admin.deleteUser) and the dashboard still work.
-- `delete_account()` (self-service erasure, runs as `postgres`) sets the override
-- itself (below), so the product's "delete my account" path is unaffected.
--
-- Only DELETE is gated. INSERT / UPDATE / TRUNCATE are untouched, so signup, db
-- reset, and the dictionary ingest (which truncates jmdict_*, never users) are
-- unaffected. Child tables (user_words/lists/...) keep their normal owner DELETE —
-- a user can still delete their own words; only removing the USER row is gated.
--
-- Forward-only. To intentionally remove users:
--   BEGIN; SET LOCAL dino.allow_user_deletion = 'on'; DELETE FROM public.users ...; COMMIT;
-- =========================================================

CREATE OR REPLACE FUNCTION public.guard_user_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- (1) Deliberate, transaction-local override.
  IF coalesce(current_setting('dino.allow_user_deletion', true), '') = 'on' THEN
    RETURN old;
  END IF;
  -- (2) GoTrue's own user management (single-account deletion via the admin API /
  --     dashboard / the edge delete-account function). It can't set a GUC, so it's
  --     allowed by role; direct postgres / service_role connections are NOT.
  IF current_user = 'supabase_auth_admin' THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION
    'user deletion is blocked on %.% — wrap an intentional deletion in '
    '"SET LOCAL dino.allow_user_deletion = ''on'';" within the same transaction',
    tg_table_schema, tg_table_name
    USING errcode = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS guard_delete ON public.users;
CREATE TRIGGER guard_delete
  BEFORE DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_deletion();

DROP TRIGGER IF EXISTS guard_delete ON auth.users;
CREATE TRIGGER guard_delete
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_deletion();

-- Keep the sanctioned self-service erasure path working: it deletes the caller's
-- own users row (cascading their data) and must pass the guard. Setting the
-- override is safe here because the function is SECURITY DEFINER and hard-scoped to
-- auth.uid() — a caller can only ever erase THEMSELVES.
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
  PERFORM set_config('dino.allow_user_deletion', 'on', true); -- local to this txn
  INSERT INTO account_deletion_log (user_id) VALUES (v_uid);
  DELETE FROM users WHERE user_id = v_uid; -- cascades all of the caller's own data
END;
$$;
