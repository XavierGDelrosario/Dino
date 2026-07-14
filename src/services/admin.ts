// Admin surface (docs/TODO.md §8). Every privileged read goes through a SECURITY
// DEFINER RPC that gates on is_admin() server-side — this client module is a thin,
// typed wrapper, NEVER the access gate. A non-admin caller gets an exception from
// the RPC (surfaced as a permission ServiceError), so even a tampered client can't
// read another user's data; the UI gate (hiding the page) is convenience only.
import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";

/** One usage row from `admin_usage_overview` — anonymized (opaque bucket, no PII). */
export interface UsageRow {
  scope: "global" | "user";
  /** Opaque, stable per-user hash; null for the single `global` row. */
  bucket: string | null;
  periodMonth: string;
  charsUsed: number;
}

export interface UsageOverview {
  /** The aggregate cross-user total for the month, if a global row exists. */
  global: UsageRow | null;
  /** Per-user usage, highest spend first. */
  users: UsageRow[];
}

/**
 * Whether the CURRENT caller is an admin. Server-decided (`is_admin()` reads
 * users.is_admin under a definer function); the client can't fake it. Used to
 * decide whether to render the admin route at all — the data RPCs re-check.
 */
export async function getIsAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) throw toServiceError(error);
  return data === true;
}

/**
 * Anonymized MT-character usage for a month (default: current UTC month).
 * Admin-only — a non-admin caller's RPC raises 42501 (mapped to a permission
 * ServiceError). `month` is a YYYY-MM-DD first-of-month date.
 */
export async function getUsageOverview(month?: string): Promise<UsageOverview> {
  const { data, error } = await supabase.rpc("admin_usage_overview", month ? { p_month: month } : {});
  if (error) throw toServiceError(error);
  const rows: UsageRow[] = (data ?? []).map((r) => ({
    scope: r.scope === "global" ? "global" : "user",
    bucket: r.bucket ?? null,
    periodMonth: r.period_month,
    charsUsed: r.chars_used,
  }));
  return {
    global: rows.find((r) => r.scope === "global") ?? null,
    users: rows.filter((r) => r.scope === "user"),
  };
}

/** One table's storage footprint (bytes). */
export interface TableSize {
  tableName: string;
  /** heap + toast + indexes — what counts against the tier storage cap. */
  totalBytes: number;
  /** heap + toast only; indexes = totalBytes - tableBytes. */
  tableBytes: number;
  rowEstimate: number;
}

/**
 * Per-table storage footprint, largest first. Admin-only. Pure size metadata
 * (no row contents), so no PII concern.
 */
export async function getTableSizes(): Promise<TableSize[]> {
  const { data, error } = await supabase.rpc("admin_table_sizes");
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    tableName: r.table_name,
    totalBytes: r.total_bytes,
    tableBytes: r.table_bytes,
    rowEstimate: r.row_estimate,
  }));
}

/** One row of the append-only failure audit. */
export interface ErrorLogRow {
  id: number;
  occurredAt: string;
  errorCode: string;
  source: string | null;
  userId: string | null;
  input: string | null;
  detail: string | null;
}

export interface ErrorLogFilter {
  /** ISO timestamp lower bound (default: server-side last 7 days). */
  since?: string;
  /** Exact error_code match. */
  code?: string;
  /** Exact user_id match. */
  userId?: string;
  /** Row cap (server clamps to 1..1000; default 200). */
  limit?: number;
}

/**
 * The append-only error log, newest first. Admin-only. Filters are optional;
 * each omitted filter falls back to the RPC's default.
 */
export async function getErrorLog(filter: ErrorLogFilter = {}): Promise<ErrorLogRow[]> {
  const args: { p_since?: string; p_code?: string; p_user?: string; p_limit?: number } = {};
  if (filter.since) args.p_since = filter.since;
  if (filter.code) args.p_code = filter.code;
  if (filter.userId) args.p_user = filter.userId;
  if (filter.limit) args.p_limit = filter.limit;
  const { data, error } = await supabase.rpc("admin_error_log", args);
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    errorCode: r.error_code,
    source: r.source,
    userId: r.user_id,
    input: r.input,
    detail: r.detail,
  }));
}

/** A feature-entitlement grant as shown in the admin list (with computed `active`). */
export interface FeatureGrant {
  id: number;
  email: string;
  feature: string;
  value: number | null;
  grantedAt: string;
  expiresAt: string | null;
  active: boolean;
  note: string | null;
}

export interface GrantFeatureInput {
  email: string;
  feature: string;
  /** Optional magnitude (e.g. the boosted quota value). */
  value?: number;
  /** ISO timestamp; omit for a permanent (never-expiring) grant. */
  expiresAt?: string;
  note?: string;
}

/**
 * Issue a feature grant to a user (by email). Admin-only, APPEND-ONLY: this can
 * only ADD entitlement — there is deliberately no revoke/shorten path (the legal
 * never-take-away rule). To extend, grant again with a later expiry.
 */
export async function grantFeature(input: GrantFeatureInput): Promise<void> {
  const { error } = await supabase.rpc("admin_grant_feature", {
    p_email: input.email.trim(),
    p_feature: input.feature.trim(),
    p_value: input.value,
    p_expires_at: input.expiresAt,
    p_note: input.note,
  });
  if (error) throw toServiceError(error);
}

/** List feature grants (optionally for one user's email), newest first. Admin-only. */
export async function listGrants(email?: string): Promise<FeatureGrant[]> {
  const { data, error } = await supabase.rpc("admin_list_grants", email ? { p_email: email.trim() } : {});
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    feature: r.feature,
    value: r.value,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    active: r.active,
    note: r.note,
  }));
}

/** One translation-quality report: the input that was translated + what was wrong. */
export interface QualityReport {
  id: number;
  reportedAt: string;
  reportedBy: string | null;
  input: string;
  description: string;
}

/**
 * File a translation-quality report. Admin-only (the RPC gates on is_admin()).
 * Trimming/empty-checks are re-done server-side.
 */
export async function reportQualityIssue(input: { input: string; description: string }): Promise<void> {
  const { error } = await supabase.rpc("admin_report_quality_issue", {
    p_input: input.input.trim(),
    p_description: input.description.trim(),
  });
  if (error) throw toServiceError(error);
}

/** The filed quality reports, newest first. Admin-only. */
export async function listQualityReports(limit?: number): Promise<QualityReport[]> {
  const { data, error } = await supabase.rpc("admin_quality_reports", limit ? { p_limit: limit } : {});
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    reportedAt: r.reported_at,
    reportedBy: r.reported_by,
    input: r.input,
    description: r.description,
  }));
}

/** Health/expiry status of one external provider. */
export interface ProviderHealth {
  provider: string;
  expiresAt: string | null;
  /** Days until credential expiry; null if no expiry recorded. */
  daysToExpiry: number | null;
  quotaNote: string | null;
  /** MT characters used this month (only for google_translate). */
  mtCharsUsed: number | null;
  updatedAt: string;
}

/** Per-provider credential expiry + usage. Admin-only. */
export async function getProviderHealth(): Promise<ProviderHealth[]> {
  const { data, error } = await supabase.rpc("admin_provider_health");
  if (error) throw toServiceError(error);
  return (data ?? []).map((r) => ({
    provider: r.provider,
    expiresAt: r.credential_expires_at,
    daysToExpiry: r.days_to_expiry,
    quotaNote: r.quota_note,
    mtCharsUsed: r.mt_chars_used,
    updatedAt: r.updated_at,
  }));
}

/** Record a provider's credential expiry / note (upsert). Admin-only. */
export async function setProvider(input: { provider: string; expiresAt?: string; quotaNote?: string }): Promise<void> {
  const { error } = await supabase.rpc("admin_set_provider", {
    p_provider: input.provider,
    p_expires_at: input.expiresAt,
    p_quota_note: input.quotaNote,
  });
  if (error) throw toServiceError(error);
}
