// =========================================================
// Lessons — WHERE the files come from, and the device cache in front of them.
//
// Source: the public `lessons` Storage bucket on the project the app already talks to
// (migration 20260796), so staging and prod each serve their own content and nothing
// new is configured per environment. VITE_LESSONS_URL overrides the base (a CDN later).
//
// Freshness without a release:
//   - index.json is fetched with `cache: "no-cache"` (revalidated every open), so a
//     newly published lesson appears on the next visit to Learn;
//   - lesson files and images are content-addressed (`<id>.<hash>.json`), so they never
//     change and need no revalidation at all.
//
// Offline: the last good index and every lesson read are kept in localStorage. A failed
// fetch falls back to them; only "never fetched, and offline" is an error. Storage can
// throw (private mode, quota), so every access is guarded — the cache is a convenience.
// =========================================================
import { parseLesson, parseLessonIndex } from "./parse";
import type { Lesson, LessonIndex } from "./types";
import type { LangCode } from "../language";

const CACHE_PREFIX = "dino.lessons.v1.";

export function lessonsBaseUrl(): string {
  const override = import.meta.env.VITE_LESSONS_URL as string | undefined;
  if (override) return override.replace(/\/+$/, "");
  const supabase = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  return `${supabase.replace(/\/+$/, "")}/storage/v1/object/public/lessons`;
}

/** A path relative to a language folder ("index.json", "images/a.1f2e.png") → URL. */
export function lessonAssetUrl(language: LangCode, path: string, base = lessonsBaseUrl()): string {
  return `${base}/${encodeURIComponent(language.toUpperCase())}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function cacheGet(key: string): unknown {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}
function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* full or blocked — the network copy still renders */
  }
}
/** Drop cached lesson files for `language` that the current index no longer names. */
function pruneFiles(language: LangCode, keep: Set<string>): void {
  try {
    const prefix = `${CACHE_PREFIX}file.${language}/`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix) && !keep.has(k.slice(prefix.length))) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

const EMPTY = (language: LangCode): LessonIndex => ({ schema: 1, language, lessons: [] });

/**
 * The lessons published for a LEARNING language. A language with no folder yet is an
 * empty list, not an error — Storage answers a missing object with 400/404.
 */
export async function getLessonIndex(language: LangCode): Promise<LessonIndex> {
  const lang = language.toUpperCase();
  const cacheKey = `index.${lang}`;
  let res: Response;
  try {
    res = await fetch(lessonAssetUrl(lang, "index.json"), { cache: "no-cache" });
  } catch (e) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return parseLessonIndex(cached);
    throw e;
  }
  if (res.status === 400 || res.status === 404) return EMPTY(lang);
  if (!res.ok) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return parseLessonIndex(cached);
    throw new Error(`Lessons unavailable (${res.status})`);
  }
  const raw: unknown = await res.json();
  const index = parseLessonIndex(raw);
  cacheSet(cacheKey, raw);
  pruneFiles(lang, new Set(index.lessons.map((l) => l.file)));
  return index;
}

/** One lesson by its manifest file name. Immutable, so a cached copy is always current. */
export async function getLesson(language: LangCode, file: string): Promise<Lesson> {
  const lang = language.toUpperCase();
  const cacheKey = `file.${lang}/${file}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    try {
      return parseLesson(cached);
    } catch {
      /* a cached copy this build can't read — refetch */
    }
  }
  const res = await fetch(lessonAssetUrl(lang, file));
  if (!res.ok) throw new Error(`Lesson unavailable (${res.status})`);
  const raw: unknown = await res.json();
  const lesson = parseLesson(raw);
  cacheSet(cacheKey, raw);
  return lesson;
}
