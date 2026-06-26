// Admin panel: the append-only failure audit (error_log). Filter by lookback
// window + error code; newest first. Reads through the is_admin()-gated RPC.
import { useCallback, useEffect, useState } from "react";
import { getErrorLog, type ErrorLogRow } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";

const WINDOWS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
];

export function ErrorLogPanel() {
  const [rows, setRows] = useState<ErrorLogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hours, setHours] = useState(24 * 7);
  const [code, setCode] = useState("");

  const load = useCallback(() => {
    setRows(null);
    setErr(null);
    // Compute the lower bound client-side from the chosen window. (Date.now is fine
    // in app code — only the workflow runtime forbids it.)
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    getErrorLog({ since, code: code.trim() || undefined })
      .then(setRows)
      .catch((e) => setErr(errorMessage(e)));
  }, [hours, code]);

  useEffect(() => { load(); }, [load]);

  const fmtTime = (iso: string) => new Date(iso).toLocaleString();

  return (
    <section className="admin__panel">
      <h3 className="admin__panel-title">Error log</h3>
      <p className="admin__muted">Append-only audit of failures (esp. paid features). Newest first.</p>

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
        <button type="button" className="admin__seg-btn" onClick={load}>Refresh</button>
      </div>

      {err && <pre className="admin__error">{err}</pre>}
      {!rows && !err && <p className="admin__muted">Loading…</p>}

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
                <td className="admin__nowrap">{fmtTime(r.occurredAt)}</td>
                <td className="admin__bucket">{r.errorCode}</td>
                <td className="admin__muted">{r.source ?? "—"}</td>
                <td className="admin__truncate">{r.input ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
