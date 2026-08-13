// =========================================================
// Media favourites — the ★ list of stories a user wants to come back to.
//
// The Media browse is RANDOM headlines with a Refresh, so an article is gone the
// moment you refresh it away. Starring keeps a POINTER to it (title + url + the
// browse snippet, plus the site/lang needed to re-fetch) — never the prose, so a
// favourite always re-opens the live article rather than a private copy.
//
// Table: media_favorites (migration 20260749) — own-rows RLS, UNIQUE (user_id, url),
// capped per user in the DB. Identity is the canonical URL, which already encodes
// site + lang + title, so starring the same story twice is one row.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import { nfcTrim } from "../../lib/text";
import { ServiceError, toServiceError } from "../errors";
import type { Database } from "../../types/database.types";
import type { Headline, WikiSite } from "./mediawiki";

export interface Favorite {
  favoriteId: string;
  title: string;
  summary: string;
  url: string;
  site: WikiSite;
  lang: string;
  /** ISO timestamp the article was starred. */
  createdAt: string;
}

type FavoriteRow = Pick<
  Database["public"]["Tables"]["media_favorites"]["Row"],
  "favorite_id" | "title" | "summary" | "url" | "site" | "lang" | "created_at"
>;

const COLUMNS = "favorite_id, title, summary, url, site, lang, created_at";

const toFavorite = (r: FavoriteRow): Favorite => ({
  favoriteId: r.favorite_id,
  title: r.title,
  summary: r.summary ?? "",
  url: r.url,
  site: r.site as WikiSite,
  lang: r.lang,
  createdAt: r.created_at,
});

/**
 * A user's starred articles, newest first — optionally only those from ONE corpus.
 *
 * The Media tab reads the wiki of the language you're LEARNING, and an article is
 * only studiable in that direction (the analysis pipeline runs on the learning
 * language), so it scopes the ★ list the same way: switching what you study
 * switches the whole corpus — headlines and stars together. Nothing is deleted,
 * so the hidden rows come back when the language does.
 *
 * OUTPUT: Favorite[] (may be empty).
 * CONSTRAINTS: RLS-scoped to the caller's own rows. Omit `site`/`lang` for all of them.
 */
export async function listFavorites(
  userId: string,
  scope?: { site?: WikiSite; lang?: string },
): Promise<Favorite[]> {
  let q = supabase
    .from("media_favorites")
    .select<string, FavoriteRow>(COLUMNS)
    .eq("user_id", userId);
  if (scope?.site) q = q.eq("site", scope.site);
  if (scope?.lang) q = q.eq("lang", scope.lang);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw toServiceError(error);
  return (data ?? []).map(toFavorite);
}

/**
 * Stars an article. Idempotent: re-starring the same URL returns the existing row
 * (the UNIQUE (user_id, url) upsert target), so a double-tap can't duplicate it.
 *
 * OUTPUT: the stored Favorite.
 * CONSTRAINTS: title + url required. Throws `conflict` when the per-user cap is hit
 * (the DB trigger raises 23505) — the caller surfaces it as a message, not a crash.
 */
export async function addFavorite(params: {
  userId: string;
  headline: Headline;
  site?: WikiSite;
  lang?: string;
}): Promise<Favorite> {
  const { userId, headline, site = "wikinews", lang = "JA" } = params;
  // NFC for the same reason every other boundary does it: a composed vs decomposed
  // Japanese title must not fork a second row for the same story.
  const title = nfcTrim(headline.title);
  const url = headline.url.trim();
  if (!title || !url) throw new ServiceError("Article title and URL are required", "validation");

  const { data, error } = await supabase
    .from("media_favorites")
    .upsert(
      {
        user_id: userId,
        title,
        summary: nfcTrim(headline.summary) || null,
        url,
        site,
        lang,
      },
      { onConflict: "user_id,url", ignoreDuplicates: false },
    )
    .select<string, FavoriteRow>(COLUMNS)
    .single();
  if (error || !data) throw toServiceError(error, "Failed to save the article");
  return toFavorite(data);
}

/**
 * Un-stars an article by its URL (what the browse list has on hand).
 * OUTPUT: void. Removing something not starred is a no-op.
 */
export async function removeFavorite(params: { userId: string; url: string }): Promise<void> {
  const { error } = await supabase
    .from("media_favorites")
    .delete()
    .eq("user_id", params.userId)
    .eq("url", params.url.trim());
  if (error) throw toServiceError(error);
}
