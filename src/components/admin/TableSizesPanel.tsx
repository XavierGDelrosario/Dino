// Admin panel: per-table storage footprint vs the tier cap (storage headroom).
import { useEffect, useState } from "react";
import { getTableSizes, type TableSize } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes } from "./format";

// Supabase Free tier database cap. Bump when the project moves to Pro (8 GB).
const DB_CAP_BYTES = 500 * 1024 * 1024;

export function TableSizesPanel() {
  const [rows, setRows] = useState<TableSize[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getTableSizes()
      .then((r) => active && setRows(r))
      .catch((e) => active && setErr(errorMessage(e)));
    return () => { active = false; };
  }, []);

  const total = rows ? rows.reduce((s, r) => s + r.totalBytes, 0) : 0;
  const pct = Math.min(100, (total / DB_CAP_BYTES) * 100);
  const near = pct >= 80;

  return (
    <section className="admin__panel">
      <h3 className="admin__panel-title">Database usage by table</h3>
      <p className="admin__muted">Total size (heap + indexes) per table, largest first.</p>

      {err && <pre className="admin__error">{err}</pre>}
      {!rows && !err && <p className="admin__muted">Loading…</p>}

      {rows && (
        <>
          <div className="admin__stat">
            <span className="admin__stat-label">Total used</span>
            <span className="admin__stat-value">
              {formatBytes(total)} <span className="admin__muted">/ {formatBytes(DB_CAP_BYTES)}</span>
            </span>
          </div>
          <div className="admin__bar" role="img" aria-label={`${pct.toFixed(0)}% of cap used`}>
            <div className={`admin__bar-fill${near ? " admin__bar-fill--warn" : ""}`} style={{ width: `${pct}%` }} />
          </div>

          <table className="admin__table">
            <thead>
              <tr>
                <th>Table</th>
                <th className="admin__num">Total</th>
                <th className="admin__num">Indexes</th>
                <th className="admin__num">Rows (est.)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tableName}>
                  <td className="admin__bucket">{r.tableName}</td>
                  <td className="admin__num">{formatBytes(r.totalBytes)}</td>
                  <td className="admin__num">{formatBytes(r.totalBytes - r.tableBytes)}</td>
                  <td className="admin__num">{r.rowEstimate.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
