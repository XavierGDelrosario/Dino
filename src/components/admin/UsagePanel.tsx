// Admin panel: anonymized MT-character usage for the current month.
import { useEffect, useState } from "react";
import { getUsageOverview, type UsageOverview } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";

export function UsagePanel() {
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getUsageOverview()
      .then((u) => active && setUsage(u))
      .catch((e) => active && setErr(errorMessage(e)));
    return () => { active = false; };
  }, []);

  return (
    <section className="admin__panel">
      <h3 className="admin__panel-title">Translation usage — this month</h3>
      <p className="admin__muted">Anonymized: each user is an opaque bucket, no email or PII.</p>

      {err && <pre className="admin__error">{err}</pre>}
      {!usage && !err && <p className="admin__muted">Loading…</p>}

      {usage && (
        <>
          <div className="admin__stat">
            <span className="admin__stat-label">Global characters (all users)</span>
            <span className="admin__stat-value">
              {usage.global ? usage.global.charsUsed.toLocaleString() : "—"}
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
                  <td className="admin__num">{u.charsUsed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
