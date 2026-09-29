-- =========================================================
-- public.users.email can only hold the caller's OWN verified address.
--
-- 2026-06-28 audit, [LOW]: `email` is client-writable (the own-row upsert in
-- services/session.ts ensureUserProfile), and nothing checked what was written. A
-- client could store someone else's address in its own row — squatting it — and
-- `email` is the lookup key of admin_grant_feature / admin_list_grants, so a grant
-- typed by address could land on the squatter.
--
-- FORCE, don't reject. A BEFORE INSERT/UPDATE trigger replaces whatever a CLIENT
-- (anon / authenticated) writes with the one value it may hold:
--   · the auth.users email, once CONFIRMED (email_confirmed_at set), lowercased
--   · otherwise the guest placeholder `<uid>@guest.dino` (what the app writes today)
-- Rejecting would break the app's own upsert in the window before a new account's
-- email is confirmed; forcing makes that window harmless — the row holds the
-- placeholder until the next boot after confirmation writes the real address.
--
-- Service role / postgres / the auth admin are NOT client roles and pass through
-- untouched (admin tooling, migrations, account deletion).
--
-- Measured before shipping (2026-09-30): 0 of 30 prod rows differ from what this
-- enforces, so no backfill.
-- =========================================================

-- SECURITY DEFINER because it reads auth.users, which clients can't. That makes
-- `current_user` the function OWNER, so the caller is identified by the request's JWT
-- role instead (request.jwt.claims ->> 'role'): 'anon' / 'authenticated' for the app, 'service_role'
-- for server code, NULL for a direct postgres connection. A trigger function can't be
-- called over the API, so nothing new is exposed — in particular no way to look up
-- another user's address by id.
CREATE OR REPLACE FUNCTION public.force_verified_user_email()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
     IN ('anon', 'authenticated') THEN
    NEW.email := coalesce(
      (SELECT lower(a.email) FROM auth.users a
        WHERE a.id::text = NEW.user_id AND a.email_confirmed_at IS NOT NULL AND a.email IS NOT NULL),
      NEW.user_id || '@guest.dino'
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.force_verified_user_email() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS force_verified_email ON public.users;
CREATE TRIGGER force_verified_email
  BEFORE INSERT OR UPDATE OF email ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.force_verified_user_email();
