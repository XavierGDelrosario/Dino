// Admin panel: translation-quality reports. A QA notebook — while testing Translate,
// record the INPUT you typed plus a DESCRIPTION of what came back wrong, so the
// observation survives the session and can be triaged against the dictionary /
// projection later. Both the write and the read go through is_admin()-gated RPCs.
import { useState } from "react";
import { listQualityReports, reportQualityIssue, type QualityReport } from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatDateTime } from "./format";

export function QualityPanel() {
  const { data: reports, error, reload } = useAdminResource<QualityReport[]>(() => listQualityReports());

  const [input, setInput] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    setFormErr(null);
    try {
      await reportQualityIssue({ input, description });
      setMsg("Report saved.");
      setInput("");
      setDescription("");
      reload();
    } catch (e) {
      setFormErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = input.trim() !== "" && description.trim() !== "";

  return (
    <AdminPanel
      title="Quality reports"
      description="Log a translation that came back wrong: what you typed, and what was inaccurate about the result."
    >
      <div className="admin__form admin__form--stack">
        <input
          className="admin__input"
          placeholder="Input — the word or sentence you translated"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <textarea
          className="admin__input admin__textarea"
          placeholder="Description — what was inaccurate (wrong sense, missing word, bad reading…)"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          type="button"
          className="admin__seg-btn admin__seg-btn--on"
          disabled={busy || !ready}
          onClick={submit}
        >
          {busy ? "Saving…" : "Report issue"}
        </button>
      </div>
      {msg && <p className="admin__muted">{msg}</p>}

      <AdminStatus error={formErr ?? error} pending={reports == null && formErr == null} />

      {reports && (
        <table className="admin__table">
          <thead>
            <tr><th>When</th><th>Input</th><th>Description</th></tr>
          </thead>
          <tbody>
            {reports.length === 0 && (
              <tr><td colSpan={3} className="admin__muted">No quality reports yet.</td></tr>
            )}
            {reports.map((r) => (
              <tr key={r.id}>
                <td className="admin__nowrap">{formatDateTime(r.reportedAt)}</td>
                <td className="admin__bucket">{r.input}</td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminPanel>
  );
}
