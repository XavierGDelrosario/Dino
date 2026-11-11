// Quiz page path + the per-device best score. A convenience (shown on the Quizzes list),
// not progress the app reasons about — cross-device scores would be a user_id table.
import type { LangCode } from "../services/language";

const KEY = "dino.quizzes.best";

export interface QuizScore {
  score: number;
  total: number;
}

/** `/quiz/<LANG>/<id>` — the quiz page's route (App matches the prefix). */
export function quizPath(language: LangCode, id: string): string {
  return `/quiz/${encodeURIComponent(language.toUpperCase())}/${encodeURIComponent(id)}`;
}

/** Parse a quiz route back into its pair; null when the path isn't one. */
export function parseQuizPath(path: string): { language: LangCode; id: string } | null {
  const m = /^\/quiz\/([^/]+)\/([^/]+)\/?$/.exec(path);
  return m ? { language: decodeURIComponent(m[1]).toUpperCase(), id: decodeURIComponent(m[2]) } : null;
}

function readAll(): Record<string, QuizScore> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const idOf = (language: LangCode, id: string) => `${language.toUpperCase()}:${id}`;

export function bestQuizScore(language: LangCode, id: string): QuizScore | null {
  const s = readAll()[idOf(language, id)];
  return s && Number.isFinite(s.score) && Number.isFinite(s.total) && s.total > 0 ? s : null;
}

/** Keep the better of the stored and the new result (by fraction correct). */
export function recordQuizScore(language: LangCode, id: string, result: QuizScore): void {
  try {
    const all = readAll();
    const prev = all[idOf(language, id)];
    if (!prev || result.score / result.total > prev.score / prev.total) {
      all[idOf(language, id)] = result;
      localStorage.setItem(KEY, JSON.stringify(all));
    }
  } catch {
    /* blocked storage — the score just isn't remembered */
  }
}
