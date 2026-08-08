// Admin panel: anonymized MT-character usage, segmented by UTC month. Usage is
// bucketed per calendar month in `translation_usage` / `global_translation_usage`
// (a new month is a new row, no reset job), so the month picker is just the RPC's
// `p_month` — the same axis `npm run mt:usage -- --month=YYYY-MM` reads.
import { useMemo, useState } from "react";
import { getUsageOverview, type UsageOverview } from "../../services/admin";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatCount } from "./format";

/** How many months the segmented control offers (oldest → current, left → right). */
const MONTH_COUNT = 6;

interface MonthOption {
  /** First-of-month date the RPC takes: "2026-07-01". */
  value: string;
  /** Short segment label: "Jul", or "Dec '25" across a year boundary. */
  label: string;
  /** Full name for the tooltip / heading. */
  title: string;
}

/**
 * The last `count` UTC months, oldest first (current month last). UTC because the
 * meter buckets in UTC on both sides (SQL `date_trunc('month', now() AT TIME ZONE
 * 'UTC')` and the edge) — a local-time month would query the wrong bucket near a
 * boundary. (`new Date()` is fine in app code; only the workflow runtime forbids it.)
 */
function recentUtcMonths(count: number, now: Date = new Date()): MonthOption[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - (count - 1 - i), 1));
    const y = d.getUTCFullYear();
    const short = d.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
    return {
      value: d.toISOString().slice(0, 10),
      // Year only when it isn't the current one, so "Dec '25" can't read as this December.
      label: y === year ? short : `${short} '${String(y).slice(2)}`,
      title: d.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  });
}

export function UsagePanel() {
  const months = useMemo(() => recentUtcMonths(MONTH_COUNT), []);
  const current = months[months.length - 1];
  const [month, setMonth] = useState(current.value);

  const { data: usage, error, reload } = useAdminResource<UsageOverview>(
    () => getUsageOverview(month),
    [month],
    { resetOnReload: true },
  );

  const selected = months.find((m) => m.value === month) ?? current;
  const userTotal = usage?.users.reduce((sum, u) => sum + u.charsUsed, 0) ?? 0;

  return (
    <AdminPanel
      title={`Translation usage — ${selected.title}`}
      description="Anonymized: each user is an opaque bucket, no email or PII. Months are UTC."
    >
      <div className="admin__filters">
        <div className="admin__seg">
          {months.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.title}
              className={`admin__seg-btn${month === m.value ? " admin__seg-btn--on" : ""}`}
              onClick={() => setMonth(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button type="button" className="admin__seg-btn admin__filters-end" onClick={reload}>
          Refresh
        </button>
      </div>

      <AdminStatus error={error} pending={usage == null} />

      {usage && (
        <>
          <div className="admin__stat">
            <span className="admin__stat-label">Global characters (all users)</span>
            <span className="admin__stat-value">
              {usage.global ? formatCount(usage.global.charsUsed) : "—"}
            </span>
          </div>
          <div className="admin__stat">
            <span className="admin__stat-label">
              Per-user total ({usage.users.length} {usage.users.length === 1 ? "user" : "users"} with spend)
            </span>
            <span className="admin__stat-value">{formatCount(userTotal)}</span>
          </div>

          <div className="admin__tablewrap">
            <table className="admin__table">
              <thead>
                <tr><th>User bucket</th><th className="admin__num">Characters</th></tr>
              </thead>
              <tbody>
                {usage.users.length === 0 && (
                  <tr><td colSpan={2} className="admin__muted">No per-user usage in {selected.title}.</td></tr>
                )}
                {usage.users.map((u) => (
                  <tr key={u.bucket}>
                    <td className="admin__bucket">{u.bucket}</td>
                    <td className="admin__num">{formatCount(u.charsUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AdminPanel>
  );
}
