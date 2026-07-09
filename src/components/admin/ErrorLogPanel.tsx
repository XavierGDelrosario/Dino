// Admin panel: the append-only failure audit (error_log). Filter by lookback
// window + error code; newest first. Reads through the is_admin()-gated RPC.
import { useState } from "react";
import { getErrorLog, type ErrorLogRow } from "../../services/admin";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatDateTime } from "./format";

const WINDOWS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
];

export function ErrorLogPanel() {
  const [hours, setHours] = useState(24 * 7);
  const [code, setCode] = useState("");

  const { data: rows, error, reload } = useAdminResource<ErrorLogRow[]>(
    () => {
      // Compute the lower bound client-side from the chosen window. (Date.now is fine
      // in app code — only the workflow runtime forbids it.)
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      return getErrorLog({ since, code: code.trim() || undefined });
    },
    [hours, code],
    { resetOnReload: true },
  );

  return (
    <AdminPanel
      title="Error log"
      description="Append-only audit of failures (esp. paid features). Newest first."
    >
      <div className="admin__filters">
        <div className="admin__seg">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={`admin__seg-btn${hours === w.hours ? " admin__seg-btn--on" : ""}`}
              onClick={() => setHours(w.hours)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <input
          className="admin__input"
          placeholder="filter by error code…"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="button" className="admin__seg-btn" onClick={reload}>Refresh</button>
      </div>

      <AdminStatus error={error} pending={rows == null} />

      {rows && (
        <table className="admin__table">
          <thead>
            <tr><th>When</th><th>Code</th><th>Source</th><th>Input</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="admin__muted">No errors in this window. 🎉</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} title={r.detail ?? undefined}>
                <td className="admin__nowrap">{formatDateTime(r.occurredAt)}</td>
                <td className="admin__bucket">{r.errorCode}</td>
                <td className="admin__muted">{r.source ?? "—"}</td>
                <td className="admin__truncate">{r.input ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminPanel>
  );
}
