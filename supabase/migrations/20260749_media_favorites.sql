-- =========================================================
-- Media favourites — the ★ list of stories a user wants to come back to.
--
-- The Media tab browses RANDOM Wikinews headlines, so an article you liked is gone
-- the moment you refresh: there is no back-button to a random batch and no search
-- worth the name. This is the durable half of that surface — star a headline, find
-- it under ★ Favourites, re-open it into the same analysis/reader.
--
-- Storage is bounded by the corpus, not by user behaviour: Japanese Wikinews is a
-- ~4k-article archive, so even a user who starred EVERY article stores ~4k rows of
-- (title, url, summary) — a few MB at the very top end. A per-user cap (below) makes
-- that ceiling explicit rather than implied, since the client is not the only door.
--
-- We store the POINTER, never the prose: title + url + the browse snippet, plus the
-- site/lang needed to re-fetch. That keeps this consistent with the media-sourcing
-- stance (derive + link out, don't re-host) and means a favourite always re-reads
-- the live article rather than a private copy that drifts.
--
-- NUMBERED 20260749, NOT 20260741 (renumbered 2026-08-03): the CLI keys a migration
-- by its NUMBER, not its filename, and 20260741 was already taken on the hosted DBs
-- by another branch's `drop_word_embeddings`. `db push` therefore read this file as
-- already-applied and silently skipped it — the table never existed on staging or
-- prod, and every client read failed with PGRST205 "Could not find the table
-- 'public.media_favorites' in the schema cache". A number is only free if no OTHER
-- branch has pushed it; check `supabase migration list --linked`, not just `ls`.
-- =========================================================

CREATE TABLE IF NOT EXISTS media_favorites (
  favorite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- Re-fetch coordinates: the MediaWiki client's site key + the app language code
  -- the article was browsed in (mediawiki.ts fetchArticle({ site, lang, title })).
  site        TEXT NOT NULL DEFAULT 'wikinews' CHECK (btrim(site) <> ''),
  lang        TEXT NOT NULL DEFAULT 'JA'       CHECK (btrim(lang) <> ''),
  title       TEXT NOT NULL CHECK (btrim(title) <> ''),
  url         TEXT NOT NULL CHECK (btrim(url) <> ''),
  summary     TEXT,                                   -- the browse snippet, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The canonical URL already encodes site + lang + title, so it is the identity:
  -- starring the same story twice is one row, and the client can un-star by URL.
  UNIQUE (user_id, url)
);

-- The list read: newest-starred first, own rows only.
CREATE INDEX IF NOT EXISTS idx_media_favorites_user
  ON media_favorites (user_id, created_at DESC);

ALTER TABLE media_favorites ENABLE ROW LEVEL SECURITY;
-- Dropped-then-created so the file REPLAYS cleanly: any DB that applied it under the
-- old 20260741 number already carries these policies, and a bare CREATE POLICY would
-- abort the migration on 42710 rather than converging.
DROP POLICY IF EXISTS "user_select_own_media_favorites" ON media_favorites;
DROP POLICY IF EXISTS "user_manage_own_media_favorites" ON media_favorites;
CREATE POLICY "user_select_own_media_favorites"
ON media_favorites FOR SELECT USING (user_id = (auth.uid())::text);
CREATE POLICY "user_manage_own_media_favorites"
ON media_favorites FOR ALL
USING (user_id = (auth.uid())::text)
WITH CHECK (user_id = (auth.uid())::text);

-- Per-user ceiling. The honest bound is the corpus (~4k articles), but a client is
-- not a guarantee — RLS lets any authenticated caller INSERT their own rows as fast
-- as they like. This turns "it can't grow past the archive" into something the DB
-- actually enforces, at the cost of one indexed COUNT per insert.
CREATE OR REPLACE FUNCTION media_favorites_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max INT := 4000;
BEGIN
  -- Re-starring an article you already have is an UPSERT, and a BEFORE INSERT
  -- trigger fires before the conflict is resolved — so exempt it, or a user sitting
  -- exactly at the cap couldn't even touch a row they already own.
  IF EXISTS (SELECT 1 FROM media_favorites
             WHERE user_id = NEW.user_id AND url = NEW.url) THEN
    RETURN NEW;
  END IF;

  IF (SELECT count(*) FROM media_favorites WHERE user_id = NEW.user_id) >= v_max THEN
    RAISE EXCEPTION 'favourite limit reached (% articles)', v_max USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_favorites_cap ON media_favorites;
CREATE TRIGGER trg_media_favorites_cap
BEFORE INSERT ON media_favorites
FOR EACH ROW EXECUTE FUNCTION media_favorites_cap();

-- =========================================================
-- Guest sweep: a favourite is now data worth keeping.
--
-- prune_anonymous_guests (20260727) deletes anonymous guests that are EMPTY, and its
-- emptiness test enumerates the per-user tables BY NAME. A guest who only ever
-- starred articles would read as empty and be reaped with their list — so the new
-- table joins that enumeration. Unchanged otherwise; re-declared in full because
-- the body is a single CREATE OR REPLACE. Keep this list in sync when adding any
-- future per-user table.
-- =========================================================
CREATE OR REPLACE FUNCTION prune_anonymous_guests(
  min_age  INTERVAL DEFAULT INTERVAL '30 days',
  max_rows INT      DEFAULT 500,
  dry_run  BOOLEAN  DEFAULT false
) RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - min_age;
  -- The monthly meter buckets in UTC on both sides (edge + SQL) — match it exactly,
  -- or a sweep near a month boundary could free someone's spent quota.
  v_month  DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_ids    TEXT[];
  v_count  INT;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT au.id::text AS id
    FROM auth.users au
    WHERE au.is_anonymous IS TRUE
      AND au.created_at < v_cutoff
      AND coalesce(au.last_sign_in_at, au.created_at) < v_cutoff
      -- Nothing of the user's would be lost:
      AND NOT EXISTS (SELECT 1 FROM user_words uw WHERE uw.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM feature_grants fg WHERE fg.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM user_limits ul WHERE ul.user_id = au.id::text)
      AND NOT EXISTS (SELECT 1 FROM media_favorites mf WHERE mf.user_id = au.id::text)
      -- …and no in-month MT spend, so deleting them can't reset a monthly quota.
      AND NOT EXISTS (
        SELECT 1 FROM translation_usage tu
        WHERE tu.user_id = au.id::text
          AND tu.period_month = v_month
          AND tu.chars_used > 0
      )
    ORDER BY au.created_at        -- oldest first, so a capped run makes steady progress
    LIMIT greatest(max_rows, 0)
  ) candidates;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  IF dry_run THEN
    RETURN array_length(v_ids, 1);
  END IF;

  -- Deliberate, transaction-local: satisfies the 20260714 deletion guard.
  PERFORM set_config('dino.allow_user_deletion', 'on', true);

  INSERT INTO account_deletion_log (user_id) SELECT unnest(v_ids);

  -- Both halves: the public row (root of the per-user FK tree) and the login itself.
  -- auth.users has no FK from public.users (user_id is TEXT), so neither cascades to
  -- the other — dropping only one would leave an orphan.
  DELETE FROM public.users WHERE user_id = ANY(v_ids);
  DELETE FROM auth.users WHERE id::text = ANY(v_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION prune_anonymous_guests(INTERVAL, INT, BOOLEAN) FROM public;
REVOKE ALL ON FUNCTION prune_anonymous_guests(INTERVAL, INT, BOOLEAN) FROM anon, authenticated;
