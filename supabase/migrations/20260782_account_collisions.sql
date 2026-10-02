-- =========================================================
-- Account collisions: email ↔ Google ↔ Apple.
--
-- Three pieces:
--
-- 1. sign_in_methods(email) — after a COLLISION (sign-up hit an existing email, a
--    password sign-in failed, an OAuth link hit an identity someone already owns) the
--    app names the way that account actually signs in: "sign in with Google", "…with
--    Apple", "…with your password". That is an enumeration surface by design (decided
--    2026-09-30 — sign-up already reveals whether an email exists), so it is
--    per-caller rate-limited and returns ONLY the provider list, never an id.
--    Apple "Hide My Email" accounts hold a relay address, so a typed real address
--    cannot match them; nothing here can fix that.
--
-- 2. Guest → account MERGE. A guest who signs in to an EXISTING account (rather than
--    upgrading in place) switches auth.uid(), which used to strand every word they
--    saved as the guest. Decided 2026-09-30: merge SILENTLY. The guest can't prove
--    ownership after the switch (its session is gone), so it mints a single-use
--    TICKET while it is still the guest; the new account presents it to claim.
--    Duplicates keep the stronger review state; list names that collide merge tags.
--    Not moved: translation_usage (a quota meter — moving it would be a quota reset
--    for the guest's next month), user_limits / feature_grants (entitlements are
--    per-account), user_confidence_daily (derived history, rebuilt going forward).
--    The emptied guest is swept by prune_anonymous_guests (20260727) like any other.
--
-- 3. ONE EMAIL, ONE ACCOUNT, ONE METHOD (decided 2026-09-30). An account signs in the
--    way it was created — password, Google, or Apple — and nothing else. The app
--    funnels people to their method (1), but GoTrue would otherwise quietly widen an
--    account: it AUTO-LINKS a Google/Apple sign-in onto a password account with the
--    same confirmed email, and a password-reset email SETS a password on a Google
--    account. So the rule is enforced here, on auth.* itself, where every path lands:
--      · auth.identities BEFORE INSERT — a user who already has an identity can't gain
--        one of a different provider, and no identity may carry an email that
--        another real account already holds. A guest has no identities (verified:
--        0 of 642 local guests), so its first method is always allowed.
--      · auth.users BEFORE UPDATE — an account with a non-email identity can't be
--        given a password.
--    GoTrue surfaces the raise as a generic server_error; the app's copy for that
--    return is the funnel ("sign in the way you created it").
-- =========================================================

-- ---------- 1. sign_in_methods ----------

CREATE TABLE IF NOT EXISTS sign_in_method_lookups (
  user_id     TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sign_in_method_lookups_user
  ON sign_in_method_lookups (user_id, looked_up_at);
ALTER TABLE sign_in_method_lookups ENABLE ROW LEVEL SECURITY; -- no policies: server-only

-- The methods one auth user signs in with: a subset of {'google','apple','email'}, in
-- that order. A password counts as 'email' even without an 'email' identity row
-- (GoTrue sets a password without adding one — verified live 2026-09-30). Under the
-- one-method rule (section 3) a real account has exactly one of these.
CREATE OR REPLACE FUNCTION public.sign_in_methods_of(p_user UUID)
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH methods AS (
    SELECT i.provider AS m FROM auth.identities i WHERE i.user_id = p_user
    UNION
    SELECT 'email' FROM auth.users u
     WHERE u.id = p_user AND coalesce(u.encrypted_password, '') <> ''
  )
  SELECT coalesce(array_agg(m ORDER BY array_position(ARRAY['google','apple','email'], m)), '{}')
    FROM methods
   WHERE m IN ('google', 'apple', 'email');
$$;
REVOKE ALL ON FUNCTION public.sign_in_methods_of(UUID) FROM public, anon, authenticated;

-- How the account holding `p_email` signs in; '{}' when no account holds it (or the
-- caller is over the limit — indistinguishable on purpose, so a scraper can't tell
-- a throttle from a miss).
CREATE OR REPLACE FUNCTION public.sign_in_methods(p_email TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller TEXT := auth.uid()::text;
  v_email  TEXT := lower(btrim(coalesce(p_email, '')));
  v_recent INT;
  v_target UUID;
BEGIN
  IF v_caller IS NULL OR v_email = '' THEN RETURN '{}'; END IF;

  -- 10 lookups per caller per hour. Guests are cheap to mint, so this bounds a
  -- scraper to GoTrue's anonymous sign-in rate limit (and the captcha, once on) × 10.
  DELETE FROM sign_in_method_lookups
   WHERE user_id = v_caller AND looked_up_at < now() - interval '1 hour';
  SELECT count(*) INTO v_recent FROM sign_in_method_lookups WHERE user_id = v_caller;
  IF v_recent >= 10 THEN RETURN '{}'; END IF;
  INSERT INTO sign_in_method_lookups (user_id) VALUES (v_caller);

  SELECT u.id INTO v_target
    FROM auth.users u
   WHERE lower(u.email) = v_email
     AND u.is_anonymous IS NOT TRUE
     AND u.id::text <> v_caller
   LIMIT 1;
  IF v_target IS NULL THEN RETURN '{}'; END IF;
  RETURN sign_in_methods_of(v_target);
END;
$$;
REVOKE ALL ON FUNCTION public.sign_in_methods(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sign_in_methods(TEXT) TO authenticated;

-- ---------- 2. guest merge ----------

CREATE TABLE IF NOT EXISTS guest_merge_tickets (
  token      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id   TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guest_merge_tickets_guest ON guest_merge_tickets (guest_id);
ALTER TABLE guest_merge_tickets ENABLE ROW LEVEL SECURITY; -- no policies: server-only

-- Called by the GUEST just before a sign-in that will switch its uid. Returns NULL
-- when there is nothing worth carrying (not a guest, or an empty one), so the client
-- stores no ticket and the common case costs one round-trip and nothing else.
CREATE OR REPLACE FUNCTION public.create_guest_merge_ticket()
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_guest TEXT := auth.uid()::text;
  v_token UUID;
BEGIN
  IF v_guest IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id::text = v_guest AND is_anonymous IS TRUE) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_words WHERE user_id = v_guest)
     AND NOT EXISTS (SELECT 1 FROM lists WHERE user_id = v_guest)
     AND NOT EXISTS (SELECT 1 FROM media_favorites WHERE user_id = v_guest)
     AND NOT EXISTS (SELECT 1 FROM placement_answers WHERE user_id = v_guest) THEN
    RETURN NULL;
  END IF;

  DELETE FROM guest_merge_tickets WHERE guest_id = v_guest; -- one live ticket per guest
  INSERT INTO guest_merge_tickets (guest_id) VALUES (v_guest) RETURNING token INTO v_token;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.create_guest_merge_ticket() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_guest_merge_ticket() TO authenticated;

-- Called by the ACCOUNT after the switch. Single-use, 1-hour ticket; the guest must
-- still be anonymous (a guest that has since upgraded is its own account now).
-- Returns how many of the guest's words ended up in the account (moved + merged);
-- 0 for an unknown/expired/spent ticket.
CREATE OR REPLACE FUNCTION public.claim_guest_merge(p_token UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acct  TEXT := auth.uid()::text;
  v_guest TEXT;
  v_words INT;
BEGIN
  IF v_acct IS NULL OR p_token IS NULL THEN RETURN 0; END IF;
  -- Merging INTO a guest isn't a thing: tickets exist for signing in to an account.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id::text = v_acct AND is_anonymous IS NOT TRUE) THEN
    RETURN 0;
  END IF;

  DELETE FROM guest_merge_tickets
   WHERE token = p_token AND created_at > now() - interval '1 hour'
  RETURNING guest_id INTO v_guest;
  IF v_guest IS NULL OR v_guest = v_acct THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id::text = v_guest AND is_anonymous IS TRUE) THEN
    RETURN 0;
  END IF;

  -- Serialize against a concurrent claim of the same guest and against the guest
  -- itself still writing from another tab.
  PERFORM pg_advisory_xact_lock(hashtext('guest_merge:' || v_guest));

  SELECT count(*) INTO v_words FROM user_words WHERE user_id = v_guest;

  -- (a) Guest words the account ALREADY has: the same dictionary sense, or the same
  --     created word (the uq_user_words_custom identity).
  CREATE TEMP TABLE _merge_dup ON COMMIT DROP AS
  SELECT g.user_word_id AS guest_uw, a.user_word_id AS acct_uw
    FROM user_words g
    JOIN user_words a
      ON a.user_id = v_acct
     AND (
       (g.dictionary_word_id IS NOT NULL AND a.dictionary_word_id = g.dictionary_word_id)
       OR (g.dictionary_word_id IS NULL AND a.dictionary_word_id IS NULL
           AND a.input = g.input AND a.source_lang = g.source_lang
           AND a.target_lang = g.target_lang AND a.custom_translation = g.custom_translation)
     )
   WHERE g.user_id = v_guest;

  -- (b) Keep the STRONGER review state: the guest's schedule wins only when its
  --     long-term stability is higher (a never-reviewed side counts as weakest).
  --     peak_confidence is a high-water mark, so it takes the max either way; the
  --     earlier save date survives; an account override is never overwritten.
  UPDATE user_words a
     SET stability          = CASE WHEN coalesce(g.stability, -1) > coalesce(a.stability, -1) THEN g.stability          ELSE a.stability          END,
         confidence_rating  = CASE WHEN coalesce(g.stability, -1) > coalesce(a.stability, -1) THEN g.confidence_rating  ELSE a.confidence_rating  END,
         last_reviewed_date = CASE WHEN coalesce(g.stability, -1) > coalesce(a.stability, -1) THEN g.last_reviewed_date ELSE a.last_reviewed_date END,
         short_stability    = CASE WHEN coalesce(g.stability, -1) > coalesce(a.stability, -1) THEN g.short_stability    ELSE a.short_stability    END,
         short_stability_at = CASE WHEN coalesce(g.stability, -1) > coalesce(a.stability, -1) THEN g.short_stability_at ELSE a.short_stability_at END,
         peak_confidence    = greatest(a.peak_confidence, g.peak_confidence),
         originally_translated_date = least(a.originally_translated_date, g.originally_translated_date),
         custom_translation = coalesce(a.custom_translation, g.custom_translation)
    FROM _merge_dup d
    JOIN user_words g ON g.user_word_id = d.guest_uw
   WHERE a.user_word_id = d.acct_uw;

  -- (c) Their review history follows onto the account's row. review_log is one row
  --     per card per UTC day (20260744); where both sides reviewed on the same day
  --     the account's row stands and the guest's is dropped.
  DELETE FROM review_log r
   USING _merge_dup d
   WHERE r.user_word_id = d.guest_uw
     AND EXISTS (SELECT 1 FROM review_log x
                  WHERE x.user_word_id = d.acct_uw AND x.reviewed_on = r.reviewed_on);
  UPDATE review_log r
     SET user_word_id = d.acct_uw
    FROM _merge_dup d
   WHERE r.user_word_id = d.guest_uw;

  -- (d) List tags on a duplicate move to the account's row (still under the guest's
  --     list for now — step (f) moves the lists), then the duplicate goes.
  INSERT INTO list_words (list_id, user_word_id)
  SELECT lw.list_id, d.acct_uw
    FROM list_words lw JOIN _merge_dup d ON d.guest_uw = lw.user_word_id
  ON CONFLICT (list_id, user_word_id) DO NOTHING;
  DELETE FROM user_words WHERE user_word_id IN (SELECT guest_uw FROM _merge_dup);

  -- (e) Everything else simply changes owner.
  UPDATE user_words SET user_id = v_acct WHERE user_id = v_guest;
  -- review_log follows its card and carries no owner of its own once 20260784 has run.
  -- Before that the legacy column still exists AND cascades from users, so a row left
  -- pointing at the guest would be deleted with the guest. Dynamic, so this function is
  -- valid whichever of the two migrations lands first; every card involved — moved in
  -- (c) or re-owned just above — now belongs to the account.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.review_log'::regclass
                AND attname = 'user_id' AND NOT attisdropped) THEN
    EXECUTE 'UPDATE review_log r SET user_id = $1
               FROM user_words uw
              WHERE uw.user_word_id = r.user_word_id
                AND uw.user_id = $1
                AND r.user_id IS DISTINCT FROM $1'
      USING v_acct;
  END IF;

  -- (f) Lists: a name the account already uses merges its tags into that list;
  --     any other list changes owner.
  INSERT INTO list_words (list_id, user_word_id)
  SELECT al.list_id, lw.user_word_id
    FROM lists gl
    JOIN lists al ON al.user_id = v_acct AND al.list_name = gl.list_name
    JOIN list_words lw ON lw.list_id = gl.list_id
   WHERE gl.user_id = v_guest
  ON CONFLICT (list_id, user_word_id) DO NOTHING;
  DELETE FROM lists gl
   WHERE gl.user_id = v_guest
     AND EXISTS (SELECT 1 FROM lists al WHERE al.user_id = v_acct AND al.list_name = gl.list_name);
  UPDATE lists SET user_id = v_acct WHERE user_id = v_guest;

  -- (g) Saved articles and calibration answers: the account's copy wins a clash.
  --     (An UPDATE skips media_favorites' BEFORE INSERT ceiling; the overshoot is
  --     bounded by one guest's worth, itself capped.)
  DELETE FROM media_favorites g
   WHERE g.user_id = v_guest
     AND EXISTS (SELECT 1 FROM media_favorites a WHERE a.user_id = v_acct AND a.url = g.url);
  UPDATE media_favorites SET user_id = v_acct WHERE user_id = v_guest;

  DELETE FROM placement_answers g
   WHERE g.user_id = v_guest
     AND EXISTS (SELECT 1 FROM placement_answers a WHERE a.user_id = v_acct AND a.word_id = g.word_id);
  UPDATE placement_answers SET user_id = v_acct WHERE user_id = v_guest;

  RETURN v_words;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_guest_merge(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.claim_guest_merge(UUID) TO authenticated;

-- ---------- 3. one method per account ----------

CREATE OR REPLACE FUNCTION public.enforce_one_sign_in_method()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.identities i
              WHERE i.user_id = NEW.user_id AND i.provider <> NEW.provider) THEN
    RAISE EXCEPTION 'one_sign_in_method: this account signs in another way'
      USING ERRCODE = 'P0001';
  END IF;
  -- A password account's user row carries its password, not always an 'email'
  -- identity, so check the password too.
  IF NEW.provider <> 'email' AND EXISTS (
       SELECT 1 FROM auth.users u
        WHERE u.id = NEW.user_id AND u.is_anonymous IS NOT TRUE
          AND coalesce(u.encrypted_password, '') <> '') THEN
    RAISE EXCEPTION 'one_sign_in_method: this account signs in with a password'
      USING ERRCODE = 'P0001';
  END IF;
  -- One email, one account: e.g. a guest linking a Google account whose address a
  -- password account already uses. Read identity_data, not the `email` column —
  -- that is GENERATED, and generated columns are still NULL in a BEFORE trigger.
  IF NEW.identity_data ->> 'email' IS NOT NULL AND EXISTS (
       SELECT 1 FROM auth.users u
        WHERE lower(u.email) = lower(NEW.identity_data ->> 'email') AND u.id <> NEW.user_id
          AND u.is_anonymous IS NOT TRUE) THEN
    RAISE EXCEPTION 'one_sign_in_method: this email already has an account'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_one_sign_in_method() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS one_sign_in_method ON auth.identities;
CREATE TRIGGER one_sign_in_method
  BEFORE INSERT ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION public.enforce_one_sign_in_method();

CREATE OR REPLACE FUNCTION public.forbid_password_on_oauth_account()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(NEW.encrypted_password, '') <> ''
     AND coalesce(OLD.encrypted_password, '') = ''
     AND OLD.is_anonymous IS NOT TRUE          -- a guest upgrading to email/password
     AND EXISTS (SELECT 1 FROM auth.identities i
                  WHERE i.user_id = NEW.id AND i.provider <> 'email') THEN
    RAISE EXCEPTION 'one_sign_in_method: this account signs in with %',
      (SELECT min(provider) FROM auth.identities WHERE user_id = NEW.id AND provider <> 'email')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forbid_password_on_oauth_account() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS one_sign_in_method_password ON auth.users;
CREATE TRIGGER one_sign_in_method_password
  BEFORE UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.forbid_password_on_oauth_account();
