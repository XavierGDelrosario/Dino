// =========================================================
// User entitlements / restrictions.
//
// What a user is allowed to do and how much. Backed by the `user_limits` table
// (per-user overrides; RLS read-own, service-role write) layered over code-level
// DEFAULTS — a user with no row gets the defaults, so the guest works with zero
// setup. Keyed on userId (= auth.uid()), so it's identical for anonymous guests
// and future authenticated users.
//
// Today it carries one limit (paragraph translation length, to stay in the
// Google Translate free tier). To add a restriction (voice, camera, a monthly
// quota): add a field + default here AND a nullable column on `user_limits`
// (and, for anything that costs money, ENFORCE it server-side in the edge
// function — the client copy below is UX only and is bypassable).
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import type { Database } from "../types/database.types";

export interface UserLimits {
  /** Max characters allowed in a single paragraph translation (free-tier guard). */
  paragraphCharLimit: number;
  /** Max characters TRANSLATED PER CALENDAR MONTH (the hard free-tier ceiling). */
  monthlyCharQuota: number;
}

/**
 * Applied when a user has no explicit override row. Tuned to keep us inside the
 * Google Translate free tier (500k chars/month): the monthly quota is the HARD
 * ceiling (set under 500k for margin), the per-request cap bounds a single call.
 * The edge function uses the same defaults (env PARAGRAPH_CHAR_LIMIT /
 * MONTHLY_CHAR_QUOTA) as its hard gate — keep them in sync.
 */
export const DEFAULT_LIMITS: UserLimits = {
  paragraphCharLimit: 2000,
  monthlyCharQuota: 450_000,
};

type UserLimitsRow = Pick<
  Database["public"]["Tables"]["user_limits"]["Row"],
  "paragraph_char_limit" | "monthly_char_quota"
>;

/**
 * The effective limits for a user: their overrides merged over the defaults.
 * A missing row (the common case for a guest) → the defaults. A NULL column →
 * that specific default. Never throws on "no row"; RLS scopes it to own row.
 *
 * OUTPUT: UserLimits (always populated, defaults filled in).
 * CONSTRAINTS: read-only; a client cannot RAISE its own limit (no write policy).
 */
export async function getUserLimits(userId: string): Promise<UserLimits> {
  const { data, error } = await supabase
    .from("user_limits")
    .select("paragraph_char_limit, monthly_char_quota")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toServiceError(error);

  const row = data as UserLimitsRow | null;
  return {
    paragraphCharLimit:
      row?.paragraph_char_limit ?? DEFAULT_LIMITS.paragraphCharLimit,
    monthlyCharQuota:
      row?.monthly_char_quota ?? DEFAULT_LIMITS.monthlyCharQuota,
  };
}

/**
 * Characters this user has had translated in the CURRENT calendar month (for a
 * "X / quota used" display). 0 when there's no usage row yet. The edge function
 * meters this and enforces the monthly quota server-side; this read is UX only.
 *
 * OUTPUT: month-to-date character count (>= 0).
 * CONSTRAINTS: read-only; RLS-scoped to the caller's own usage.
 */
export async function getMonthlyUsage(userId: string): Promise<number> {
  // First day of the current month (UTC), matching the edge function's bucket.
  const now = new Date();
  const periodMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const { data, error } = await supabase
    .from("translation_usage")
    .select("chars_used")
    .eq("user_id", userId)
    .eq("period_month", periodMonth)
    .maybeSingle();
  if (error) throw toServiceError(error);
  return (data as { chars_used: number } | null)?.chars_used ?? 0;
}
