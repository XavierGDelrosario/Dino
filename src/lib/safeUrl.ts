// Only an http(s) URL may become a link. Anything else — `javascript:`, `data:`, a
// bare word — renders as no link at all, never as an executable href. PURE.
//
// Used where a stored or fetched URL meets an <a href> (saved articles, article
// credits) and where a saved article is written (services/media/favorites), mirroring
// the database CHECK on media_favorites.url (migration 20260795).

/** `url` when it is http(s), else undefined. Leading/trailing whitespace is ignored. */
export function httpUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  return /^https?:\/\/\S+$/i.test(u) ? u : undefined;
}
