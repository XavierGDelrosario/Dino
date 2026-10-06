// The study streak (the 🔥 counter in the top bar, the two big numbers on /goals) and
// today's progress against the daily goals.
//
// ONE small read: the `study_days` RPC (migration 20260790) returns one row per LOCAL
// day with any activity — words saved + cards graded — bucketed in the browser's
// timezone (same rule as profile_history). Everything after the fetch is PURE and
// pinned by tests/services/streak.test.ts.
//
// A day is STUDIED when a word was saved OR a card was graded. Either kind of work
// keeps the streak: a learner who only reviews is studying, and so is one who only
// reads and saves. The goals (services/goals.ts) are a separate question — a streak
// never requires the goal to be met, so it stays reachable on a thin day.
//
// Degrades, never breaks: a database without study_days() (deploy order — see the
// "prod changes never disrupt availability" rule) makes getStudyDays() answer null and
// the badge hides, instead of a failed RPC on every page load.
import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import { localTimeZone } from "./history";
import { dayKey, parseDayKey } from "./words/filters";

export interface StudyDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Words saved that day. */
  added: number;
  /** Distinct cards graded that day. */
  reviewed: number;
  /** Grades given that day (a card graded twice counts twice). */
  reviews: number;
}

export interface Streaks {
  /** Consecutive studied days ending today — or ending yesterday, when today is not
   *  yet studied (the streak is still alive until midnight). */
  current: number;
  /** The longest run ever. ≥ current. */
  longest: number;
  /** Whether today has any activity yet. */
  studiedToday: boolean;
}

export interface TodayProgress {
  added: number;
  reviews: number;
}

/** PostgREST's "no such function" — the database predates migration 20260790. */
const isMissingFunction = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST202";

/** Latched by the first miss: an un-migrated database costs one failed RPC per session. */
let studyDaysAvailable = true;

/** Tests only. */
export function resetStreakAvailability(): void {
  studyDaysAvailable = true;
}

/**
 * Every studied day for the signed-in user, oldest first — or **null when this
 * database has no study_days() yet**.
 */
export async function getStudyDays(tz = localTimeZone()): Promise<StudyDay[] | null> {
  if (!studyDaysAvailable) return null;
  const { data, error } = await supabase.rpc("study_days", { p_tz: tz });
  if (error) {
    if (isMissingFunction(error)) {
      studyDaysAvailable = false;
      return null;
    }
    throw toServiceError(error);
  }
  return (data ?? []).map((r) => ({
    day: String(r.day),
    added: Number(r.added) || 0,
    reviewed: Number(r.reviewed) || 0,
    reviews: Number(r.reviews) || 0,
  }));
}

/** The streak rule, in one place. */
export const isStudied = (d: StudyDay): boolean => d.added > 0 || d.reviews > 0;

/** The local day before `key`. */
export function previousDay(key: string): string {
  const d = parseDayKey(key);
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

/**
 * Current + longest streak from the day list. `today` is the local day key the
 * numbers are read on (defaults to now); passing it keeps the maths deterministic.
 */
export function computeStreaks(days: StudyDay[], today = dayKey(new Date())): Streaks {
  const studied = new Set(days.filter(isStudied).map((d) => d.day));
  const studiedToday = studied.has(today);

  // Walk back from today, or from yesterday when today hasn't happened yet — a
  // streak isn't broken by a day that is still going.
  let current = 0;
  let cursor = studiedToday ? today : previousDay(today);
  while (studied.has(cursor)) {
    current++;
    cursor = previousDay(cursor);
  }

  // Longest: one pass over the sorted studied days, counting consecutive ones.
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...studied].sort()) {
    run = prev !== null && previousDay(day) === prev ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }

  return { current, longest: Math.max(longest, current), studiedToday };
}

/** Today's counts, zero when nothing has happened yet. */
export function todayProgress(days: StudyDay[], today = dayKey(new Date())): TodayProgress {
  const d = days.find((x) => x.day === today);
  return { added: d?.added ?? 0, reviews: d?.reviews ?? 0 };
}
