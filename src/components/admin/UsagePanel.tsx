// Admin panel: anonymized MT-character usage for the current month.
import { getUsageOverview, type UsageOverview } from "../../services/admin";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatCount } from "./format";

export function UsagePanel() {
  const { data: usage, error } = useAdminResource<UsageOverview>(getUsageOverview);

  return (
    <AdminPanel
      title="Translation usage — this month"
      description="Anonymized: each user is an opaque bucket, no email or PII."
    >
      <AdminStatus error={error} pending={usage == null} />

      {usage && (
        <>
          <div className="admin__stat">
            <span className="admin__stat-label">Global characters (all users)</span>
            <span className="admin__stat-value">
              {usage.global ? formatCount(usage.global.charsUsed) : "—"}
            </span>
          </div>

          <table className="admin__table">
            <thead>
              <tr><th>User bucket</th><th className="admin__num">Characters</th></tr>
            </thead>
            <tbody>
              {usage.users.length === 0 && (
                <tr><td colSpan={2} className="admin__muted">No per-user usage this month.</td></tr>
              )}
              {usage.users.map((u) => (
                <tr key={u.bucket}>
                  <td className="admin__bucket">{u.bucket}</td>
                  <td className="admin__num">{formatCount(u.charsUsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </AdminPanel>
  );
}
