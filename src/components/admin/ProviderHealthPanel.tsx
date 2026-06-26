// Admin panel: third-party API health. Tracks each provider's credential expiry
// (manually maintained — most providers expose no expiry API) with a warning when
// it's near, plus the MT usage we already track. Click a row to edit its expiry/note.
import { useCallback, useEffect, useState } from "react";
import { getProviderHealth, setProvider, type ProviderHealth } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";

const WARN_DAYS = 30;

export function ProviderHealthPanel() {
  const [rows, setRows] = useState<ProviderHealth[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    getProviderHealth().then(setRows).catch((e) => setErr(errorMessage(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (p: ProviderHealth) => {
    setEditing(p.provider);
    setExpires(p.expiresAt ?? "");
    setNote(p.quotaNote ?? "");
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      await setProvider({ provider: editing, expiresAt: expires || undefined, quotaNote: note || undefined });
      setEditing(null);
      load();
    } catch (e) {
      setErr(errorMessage(e));
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
    <section className="admin__panel">
      <h3 className="admin__panel-title">Third-party API health</h3>
      <p className="admin__muted">
        Credential expiry is tracked manually (most providers expose no expiry API). Live usage-vs-quota
        polling (Brevo, Supabase billing) is a follow-up; MT chars come from our own usage table.
      </p>

      {err && <pre className="admin__error">{err}</pre>}
      {!rows && !err && <p className="admin__muted">Loading…</p>}

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
                  <td className="admin__muted">{p.mtCharsUsed != null ? `${p.mtCharsUsed.toLocaleString()} ch` : "—"}</td>
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
                  <td className="admin__muted">{p.mtCharsUsed != null ? `${p.mtCharsUsed.toLocaleString()} ch` : "—"}</td>
                  <td className="admin__truncate" title={p.quotaNote ?? undefined}>{p.quotaNote ?? "—"}</td>
                  <td className="admin__nowrap"><button type="button" className="admin__seg-btn" onClick={() => startEdit(p)}>Edit</button></td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
