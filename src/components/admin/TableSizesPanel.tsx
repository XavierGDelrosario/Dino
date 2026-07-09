// Admin panel: per-table storage footprint vs the tier cap (storage headroom).
import { getTableSizes, type TableSize } from "../../services/admin";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatBytes, formatCount } from "./format";

// Supabase Free tier database cap. Bump when the project moves to Pro (8 GB).
const DB_CAP_BYTES = 500 * 1024 * 1024;

export function TableSizesPanel() {
  const { data: rows, error } = useAdminResource<TableSize[]>(getTableSizes);

  const total = rows ? rows.reduce((s, r) => s + r.totalBytes, 0) : 0;
  const pct = Math.min(100, (total / DB_CAP_BYTES) * 100);
  const near = pct >= 80;

  return (
    <AdminPanel
      title="Database usage by table"
      description="Total size (heap + indexes) per table, largest first."
    >
      <AdminStatus error={error} pending={rows == null} />

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
                  <td className="admin__num">{formatCount(r.rowEstimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </AdminPanel>
  );
}
