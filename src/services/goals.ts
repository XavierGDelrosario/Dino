// Daily goals: how many NEW WORDS to save and how many REVIEWS (grades) to give per
// day. Picked on /goals from a fixed set of buttons; stored on `users` (migration
// 20260790) so they follow the account across devices like the language pair.
//
// NULL in the database = the default. A user who never opens /goals has a goal anyway,
// so the progress copy ("3 / 5 today") always has a denominator.
//
// The projections ("in 1 week: 35 new words") are pure arithmetic over the goal and
// deliberately naive — goal × days, no decay, no weekends — because the point is to
// make the choice tangible, not to forecast.
//
// Degrades: a database without the columns yet (42703) reads as the defaults and
// swallows writes with a warning, instead of breaking the page. The profile read in
// session.ts does NOT select these columns for the same reason — one new column must
// never 42703 the whole profile.
import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";

export interface Goals {
  /** Words to save per day. */
  newWords: number;
  /** Grades to give per day. */
  reviews: number;
}

/** The buttons on /goals, smallest first. */
export const NEW_WORDS_GOAL_OPTIONS = [5, 10, 20, 40] as const;
export const REVIEWS_GOAL_OPTIONS = [20, 100, 200, 400] as const;

/** The smallest option of each: a goal a new learner can meet on day one. */
export const DEFAULT_GOALS: Goals = { newWords: 5, reviews: 20 };

/** The horizons the projection list shows, in days. */
export const PROJECTION_HORIZONS = [
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "halfYear", days: 182 },
  { key: "year", days: 365 },
] as const;

export type HorizonKey = (typeof PROJECTION_HORIZONS)[number]["key"];

/** goal × days for each horizon. */
export function projections(perDay: number): Array<{ key: HorizonKey; days: number; total: number }> {
  return PROJECTION_HORIZONS.map((h) => ({ ...h, total: perDay * h.days }));
}

/** Postgres "column does not exist" — the database predates migration 20260790. */
const isMissingColumn = (error: { code?: string } | null): boolean => error?.code === "42703";

let goalsAvailable = true;

/** Tests only. */
export function resetGoalsAvailability(): void {
  goalsAvailable = true;
}

/** The user's goals, defaults filled in. */
export async function getGoals(userId: string): Promise<Goals> {
  if (!goalsAvailable) return DEFAULT_GOALS;
  const { data, error } = await supabase
    .from("users")
    .select("daily_new_words_goal, daily_reviews_goal")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error)) {
      goalsAvailable = false;
      return DEFAULT_GOALS;
    }
    throw toServiceError(error);
  }
  return {
    newWords: data?.daily_new_words_goal ?? DEFAULT_GOALS.newWords,
    reviews: data?.daily_reviews_goal ?? DEFAULT_GOALS.reviews,
  };
}

/** Save one or both goals. Pass only the fields to change. */
export async function setGoals(userId: string, patch: Partial<Goals>): Promise<void> {
  if (!goalsAvailable) {
    console.warn("[goals] this database has no goal columns yet; choice not saved");
    return;
  }
  const update: { daily_new_words_goal?: number; daily_reviews_goal?: number } = {};
  if (patch.newWords !== undefined) update.daily_new_words_goal = patch.newWords;
  if (patch.reviews !== undefined) update.daily_reviews_goal = patch.reviews;
  if (Object.keys(update).length === 0) return;
  const { error } = await supabase.from("users").update(update).eq("user_id", userId);
  if (error) {
    if (isMissingColumn(error)) {
      goalsAvailable = false;
      console.warn("[goals] this database has no goal columns yet; choice not saved");
      return;
    }
    throw toServiceError(error);
  }
}
