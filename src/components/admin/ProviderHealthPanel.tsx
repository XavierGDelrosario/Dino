// Admin panel: third-party API health. Tracks each provider's credential expiry
// (manually maintained — most providers expose no expiry API) with a warning when
// it's near, plus the MT usage we already track. Click a row to edit its expiry/note.
import { useState } from "react";
import { getProviderHealth, setProvider, type ProviderHealth } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatCount } from "./format";

const WARN_DAYS = 30;

export function ProviderHealthPanel() {
  const { data: rows, error, reload } = useAdminResource<ProviderHealth[]>(getProviderHealth);
  const [editing, setEditing] = useState<string | null>(null);
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const startEdit = (p: ProviderHealth) => {
    setEditing(p.provider);
    setExpires(p.expiresAt ?? "");
    setNote(p.quotaNote ?? "");
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setFormErr(null);
    try {
      await setProvider({ provider: editing, expiresAt: expires || undefined, quotaNote: note || undefined });
      setEditing(null);
      reload();
    } catch (e) {
      setFormErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const expiryCell = (p: ProviderHealth) => {
    if (p.expiresAt == null) return <span className="admin__muted">not set</span>;
    const warn = p.daysToExpiry != null && p.daysToExpiry <= WARN_DAYS;
    return (
      <span className={warn ? "admin__warn" : undefined}>
        {p.expiresAt} {p.daysToExpiry != null && `(${p.daysToExpiry}d)`}
      </span>
    );
  };

  return (
    <AdminPanel
      title="Third-party API health"
      description={
        <>
          Credential expiry is tracked manually (most providers expose no expiry API). Live usage-vs-quota
          polling (Brevo, Supabase billing) is a follow-up; MT chars come from our own usage table.
        </>
      }
    >
      <AdminStatus error={formErr ?? error} pending={rows == null && formErr == null} />

      {rows && (
        <table className="admin__table">
          <thead>
            <tr><th>Provider</th><th>Cred. expiry</th><th>Usage</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              editing === p.provider ? (
                <tr key={p.provider}>
                  <td className="admin__bucket">{p.provider}</td>
                  <td><input className="admin__input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></td>
                  <td className="admin__muted">{formatCount(p.mtCharsUsed, " ch")}</td>
                  <td><input className="admin__input" value={note} onChange={(e) => setNote(e.target.value)} /></td>
                  <td className="admin__nowrap">
                    <button type="button" className="admin__seg-btn admin__seg-btn--on" disabled={busy} onClick={save}>Save</button>
                    <button type="button" className="admin__seg-btn" onClick={() => setEditing(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={p.provider}>
                  <td className="admin__bucket">{p.provider}</td>
                  <td>{expiryCell(p)}</td>
                  <td className="admin__muted">{formatCount(p.mtCharsUsed, " ch")}</td>
                  <td className="admin__truncate" title={p.quotaNote ?? undefined}>{p.quotaNote ?? "—"}</td>
                  <td className="admin__nowrap"><button type="button" className="admin__seg-btn" onClick={() => startEdit(p)}>Edit</button></td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}
    </AdminPanel>
  );
}
