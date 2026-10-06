-- =========================================================
-- media_favorites.url must be an http(s) URL.
--
-- A saved article is a POINTER the app renders as a link (<a href>). The normal app
-- only ever saves URLs the Wikinews API returned, but the table is own-rows writable
-- through PostgREST, so a user could store `javascript:` and hand themselves a link
-- that runs script — self-inflicted only (RLS keeps the row theirs), still a hole
-- that costs one CHECK to close. Measured before adding it: 6 rows on prod, 0 on
-- staging, all https — so the constraint is added VALIDATED, no NOT VALID step.
-- The client guards the same way where the link renders (lib/urlFilter httpUrl), so
-- an older row or a different site can never become an executable href.
-- =========================================================

ALTER TABLE media_favorites
  ADD CONSTRAINT media_favorites_url_http CHECK (url ~* '^https?://');
