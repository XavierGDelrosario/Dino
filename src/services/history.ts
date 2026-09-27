// The profile's History section: per-day activity + confidence over time.
//
// ONE read (the `profile_history` RPC, migration 20260775) returns everything, so the
// profile never loads the vocabulary itself. Everything past the fetch is PURE — the
// bucketing/cumulative/label maths below is what the charts draw and what the tests pin.
//
// Days: `days` arrive bucketed in the CALLER's timezone (we pass the browser's IANA
// zone), so they line up with dayKey's local days. The confidence snapshots are UTC
// days (written by a nightly job) and are read as-is — at most a few hours off, and
// only on the confidence plot.
import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import { dayKey, parseDayKey } from "./words/filters";
import { labelForBand, proficiencyFrameworkFor } from "./proficiency";
import type { LangCode } from "./language";

export interface HistoryDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Words saved that day (deleted words are gone from every day). */
  added: number;
  /** Distinct cards reviewed that day. */
  reviewed: number;
  /** Total grades that day (a card graded twice counts twice). */
  reviews: number;
}

export interface HistoryBand {
  /** Proficiency band ordinal (1 = easiest); -1 = unranked. */
  band: number;
  n: number;
  /** Live average display confidence, 0..5. */
  avgConf: number | null;
}

export interface ConfidenceSnapshot {
  /** UTC day the snapshot closes. */
  day: string;
  wordCount: number;
  avgConf: number | null;
  mainLang: LangCode | null;
  /** Fixed slots: [0] = unranked, [b] = band b. */
  bandN: number[];
  bandConf: (number | null)[];
}

export interface ProfileHistory {
  mainLang: LangCode | null;
  days: HistoryDay[];
  bands: HistoryBand[];
  confidence: ConfidenceSnapshot[];
}

/** PostgREST's "no such function" — the database predates migration 20260775. */
const isMissingFunction = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST202";

/** Latched by the first miss (same shape as lists.getListOverview): an un-migrated
 *  database costs one failed RPC per session, and a reload re-probes. */
let historyAvailable = true;

/** The browser's IANA zone, so the server buckets days the way dayKey does. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const numOrNull = (v: unknown): number | null =>
  v == null || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * The whole History payload for the signed-in user, or **null when this database has
 * no profile_history() yet** — the section hides rather than the profile erroring,
 * because the client and the database deploy separately.
 */
export async function getProfileHistory(tz = localTimeZone()): Promise<ProfileHistory | null> {
  if (!historyAvailable) return null;
  const { data, error } = await supabase.rpc("profile_history", { p_tz: tz });
  if (isMissingFunction(error)) {
    historyAvailable = false;
    console.warn("[history] this database predates migration 20260775; hiding History.");
    return null;
  }
  if (error) throw toServiceError(error);
  return parseHistory(data);
}

type Raw = Record<string, unknown>;

/** RPC JSON → domain. Defensive about shape: an older/newer function must not crash. */
export function parseHistory(data: unknown): ProfileHistory {
  const d = (data ?? {}) as Raw;
  const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
  return {
    mainLang: (d.main_lang as LangCode | null) ?? null,
    days: arr(d.days).map((r) => ({
      day: String(r.day),
      added: num(r.added),
      reviewed: num(r.reviewed),
      reviews: num(r.reviews),
    })),
    bands: arr(d.bands).map((r) => ({
      band: num(r.band),
      n: num(r.n),
      avgConf: numOrNull(r.avg_conf),
    })),
    confidence: arr(d.confidence).map((r) => ({
      day: String(r.day),
      wordCount: num(r.word_count),
      avgConf: numOrNull(r.avg_conf),
      mainLang: (r.main_lang as LangCode | null) ?? null,
      bandN: Array.isArray(r.band_n) ? (r.band_n as unknown[]).map(num) : [],
      bandConf: Array.isArray(r.band_conf) ? (r.band_conf as unknown[]).map(numOrNull) : [],
    })),
  };
}

// ── Pure bucketing ─────────────────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";
export type HistoryRange = "30d" | "12w" | "12m";
export type ActivityMetric = "added" | "total" | "reviewed";

export const RANGES: Record<HistoryRange, { granularity: Granularity; count: number }> = {
  "30d": { granularity: "day", count: 30 },
  "12w": { granularity: "week", count: 12 },
  "12m": { granularity: "month", count: 12 },
};

/** The first day of the bucket `d` falls in: itself, its Monday, or the 1st. */
export function bucketStart(d: Date, g: Granularity): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  if (g === "month") x.setDate(1);
  return x;
}

/** The next bucket's start. */
function nextStart(d: Date, g: Granularity): Date {
  const x = new Date(d);
  if (g === "day") x.setDate(x.getDate() + 1);
  else if (g === "week") x.setDate(x.getDate() + 7);
  else x.setMonth(x.getMonth() + 1);
  return x;
}

/** The `count` bucket starts ending with the one containing `today`, oldest first. */
export function bucketStarts(range: HistoryRange, today: Date): Date[] {
  const { granularity: g, count } = RANGES[range];
  const out: Date[] = [];
  let cur = bucketStart(today, g);
  for (let i = 0; i < count; i++) {
    out.unshift(cur);
    const prev = new Date(cur);
    if (g === "day") prev.setDate(prev.getDate() - 1);
    else if (g === "week") prev.setDate(prev.getDate() - 7);
    else prev.setMonth(prev.getMonth() - 1);
    cur = prev;
  }
  return out;
}

export interface Point {
  /** Bucket start, `YYYY-MM-DD`. */
  key: string;
  /** null = no data in this bucket (a gap, not a zero). */
  value: number | null;
}

/**
 * One activity series over `range`. `added` / `reviewed` SUM within each bucket;
 * `total` is the running vocabulary size at the END of each bucket — every word
 * saved up to then, including before the range starts (and never a deleted one).
 */
export function activitySeries(
  days: HistoryDay[],
  metric: ActivityMetric,
  range: HistoryRange,
  today: Date,
): Point[] {
  const { granularity: g } = RANGES[range];
  const starts = bucketStarts(range, today);
  const keys = starts.map(dayKey);
  if (metric === "total") {
    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
    return starts.map((s, i) => {
      const end = dayKey(nextStart(s, g)); // exclusive
      let total = 0;
      for (const d of sorted) {
        if (d.day >= end) break;
        total += d.added;
      }
      return { key: keys[i], value: total };
    });
  }
  const sums = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const d of days) {
    const k = dayKey(bucketStart(parseDayKey(d.day), g));
    if (sums.has(k)) sums.set(k, sums.get(k)! + (metric === "added" ? d.added : d.reviewed));
  }
  return keys.map((k) => ({ key: k, value: sums.get(k)! }));
}

/** The label for a band slot/ordinal in `lang`'s framework; unranked for -1/0. */
export function bandLabel(band: number, lang: LangCode | null, unranked: string): string {
  if (band <= 0 || !lang) return unranked;
  const fw = proficiencyFrameworkFor(lang);
  return (fw && labelForBand(fw, band)) ?? unranked;
}

export interface BandRow {
  band: number;
  label: string;
  n: number;
  avgConf: number | null;
}

/** Live confidence per level: easiest → hardest, unranked last. */
export function bandRows(
  bands: HistoryBand[],
  lang: LangCode | null,
  unranked: string,
): BandRow[] {
  const rank = (b: number) => (b <= 0 ? Number.MAX_SAFE_INTEGER : b);
  return [...bands]
    .sort((a, b) => rank(a.band) - rank(b.band))
    .map((b) => ({ band: b.band, label: bandLabel(b.band, lang, unranked), n: b.n, avgConf: b.avgConf }));
}

export interface ConfidenceLines {
  overall: Point[];
  /** One line per level slot present in any snapshot (unranked = slot 0, last). */
  bands: { slot: number; label: string; points: Point[] }[];
}

/**
 * Confidence over `range` from the nightly snapshots. Values AVERAGE within a bucket
 * (a week of snapshots is one point, not seven summed); a bucket with no snapshot is
 * a gap (null) — the plot bridges it, since an idle stretch writes nothing.
 */
export function confidenceLines(
  snaps: ConfidenceSnapshot[],
  range: HistoryRange,
  today: Date,
  lang: LangCode | null,
  unranked: string,
): ConfidenceLines {
  const { granularity: g } = RANGES[range];
  const keys = bucketStarts(range, today).map(dayKey);
  const inRange = new Set(keys);
  const acc = new Map<string, { sum: number; n: number }>(); // `${slot}|${key}`; slot -1 = overall
  const slots = new Set<number>();
  const add = (slot: number, key: string, v: number | null) => {
    if (v == null) return;
    const id = `${slot}|${key}`;
    const a = acc.get(id) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n += 1;
    acc.set(id, a);
  };
  for (const s of snaps) {
    const key = dayKey(bucketStart(parseDayKey(s.day), g));
    if (!inRange.has(key)) continue;
    add(-1, key, s.avgConf);
    s.bandConf.forEach((c, slot) => {
      if ((s.bandN[slot] ?? 0) > 0 && c != null) {
        slots.add(slot);
        add(slot, key, c);
      }
    });
  }
  const line = (slot: number): Point[] =>
    keys.map((k) => {
      const a = acc.get(`${slot}|${k}`);
      return { key: k, value: a ? a.sum / a.n : null };
    });
  const ordered = [...slots].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  return {
    overall: line(-1),
    bands: ordered.map((slot) => ({ slot, label: bandLabel(slot, lang, unranked), points: line(slot) })),
  };
}

/** Per-day counts for one calendar metric, keyed by local day. */
export function dayCounts(days: HistoryDay[], metric: "added" | "reviewed"): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of days) {
    const v = metric === "added" ? d.added : d.reviewed;
    if (v > 0) m.set(d.day, v);
  }
  return m;
}
