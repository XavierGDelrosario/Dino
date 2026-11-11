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
import { parseLesson, parseLessonIndex, parseQuiz } from "./parse";
import type { Lesson, LessonIndex, Quiz } from "./types";
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
/**
 * Drop cached files under `<language>/<sub>` that the current index no longer names.
 * Scoped to ONE manifest's folder: lessons live at the language root and quizzes under
 * `quizzes/`, so pruning lessons must not touch cached quizzes (or vice versa).
 */
function pruneFiles(language: LangCode, sub: string, keep: Set<string>): void {
  try {
    const prefix = `${CACHE_PREFIX}file.${language}/`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const path = k.slice(prefix.length);
      const inScope = sub ? path.startsWith(sub) : !path.includes("/");
      if (inScope && !keep.has(path)) localStorage.removeItem(k);
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
  return fetchIndex(language, "");
}

/** A manifest under `<LANG>/<prefix>` ("" = lessons, "quizzes/" = quizzes). */
async function fetchIndex(language: LangCode, prefix: string): Promise<LessonIndex> {
  const lang = language.toUpperCase();
  const cacheKey = `index.${lang}/${prefix}`;
  let res: Response;
  try {
    res = await fetch(lessonAssetUrl(lang, `${prefix}index.json`), { cache: "no-cache" });
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
  pruneFiles(lang, prefix, new Set(index.lessons.map((l) => `${prefix}${l.file}`)));
  return index;
}

/** The quizzes published for a LEARNING language (`<LANG>/quizzes/index.json`). */
export async function getQuizIndex(language: LangCode): Promise<LessonIndex> {
  return fetchIndex(language, "quizzes/");
}

/** One quiz by its manifest file name (immutable, like a lesson file). */
export async function getQuiz(language: LangCode, file: string): Promise<Quiz> {
  return fetchFile(language, `quizzes/${file}`, parseQuiz);
}

/** One lesson by its manifest file name. Immutable, so a cached copy is always current. */
export async function getLesson(language: LangCode, file: string): Promise<Lesson> {
  return fetchFile(language, file, parseLesson);
}

/** An immutable content file at `<LANG>/<path>`, through the device cache. */
async function fetchFile<T>(language: LangCode, path: string, parse: (raw: unknown) => T): Promise<T> {
  const lang = language.toUpperCase();
  const cacheKey = `file.${lang}/${path}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    try {
      return parse(cached);
    } catch {
      /* a cached copy this build can't read — refetch */
    }
  }
  const res = await fetch(lessonAssetUrl(lang, path));
  if (!res.ok) throw new Error(`Content unavailable (${res.status})`);
  const raw: unknown = await res.json();
  const parsed = parse(raw);
  cacheSet(cacheKey, raw);
  return parsed;
}
