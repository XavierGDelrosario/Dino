// Admin panel: feature grants. Issue a grant (by email) and view existing ones.
// APPEND-ONLY by design — there is no revoke control here, on purpose: the legal
// rule is grants can be extended but never taken away (re-grant with a later
// expiry to extend). The data model enforces it; the UI just reflects it.
import { useCallback, useEffect, useState } from "react";
import { grantFeature, listGrants, type FeatureGrant } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";

const FEATURES = ["voice", "camera", "handwriting", "llm", "quota_boost"];

export function GrantsPanel() {
  const [grants, setGrants] = useState<FeatureGrant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // form state
  const [email, setEmail] = useState("");
  const [feature, setFeature] = useState(FEATURES[0]);
  const [value, setValue] = useState("");
  const [expires, setExpires] = useState(""); // yyyy-mm-dd or ""
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    listGrants()
      .then(setGrants)
      .catch((e) => setErr(errorMessage(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await grantFeature({
        email,
        feature,
        value: value.trim() ? Number(value) : undefined,
        // end of the chosen day, local → ISO; omit for a permanent grant
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined,
        note: note.trim() || undefined,
      });
      setMsg(`Granted “${feature}” to ${email}.`);
      setValue(""); setExpires(""); setNote("");
      load();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

  return (
    <section className="admin__panel">
      <h3 className="admin__panel-title">Feature grants</h3>
      <p className="admin__muted">Grant-only — entitlements can be extended (re-grant with a later expiry) but never revoked.</p>

      <div className="admin__form">
        <input className="admin__input" placeholder="user email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="admin__input" value={feature} onChange={(e) => setFeature(e.target.value)}>
          {FEATURES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input className="admin__input" placeholder="value (optional)" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="admin__field">
          <span className="admin__muted">expires</span>
          <input className="admin__input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <input className="admin__input" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="admin__seg-btn admin__seg-btn--on" disabled={busy || !email.trim()} onClick={submit}>
          {busy ? "Granting…" : "Grant"}
        </button>
      </div>
      {msg && <p className="admin__muted">{msg}</p>}
      {err && <pre className="admin__error">{err}</pre>}

      {!grants && !err && <p className="admin__muted">Loading…</p>}
      {grants && (
        <table className="admin__table">
          <thead>
            <tr><th>User</th><th>Feature</th><th className="admin__num">Value</th><th>Granted</th><th>Expires</th><th>Status</th></tr>
          </thead>
          <tbody>
            {grants.length === 0 && <tr><td colSpan={6} className="admin__muted">No grants yet.</td></tr>}
            {grants.map((g) => (
              <tr key={g.id}>
                <td className="admin__truncate" title={g.note ?? undefined}>{g.email}</td>
                <td className="admin__bucket">{g.feature}</td>
                <td className="admin__num">{g.value ?? "—"}</td>
                <td className="admin__nowrap">{fmt(g.grantedAt)}</td>
                <td className="admin__nowrap">{g.expiresAt ? fmt(g.expiresAt) : "never"}</td>
                <td>{g.active ? <span className="admin__badge admin__badge--ok">active</span> : <span className="admin__badge">expired</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
