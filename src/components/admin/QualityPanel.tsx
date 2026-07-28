// Admin panel: translation-quality reports. A QA notebook — while testing Translate,
// record the INPUT you typed plus a DESCRIPTION of what came back wrong, so the
// observation survives the session and can be triaged against the dictionary /
// projection later. Both the write and the read go through is_admin()-gated RPCs.
//
// Each report carries a STATUS so a fixed one can be checked off: the list defaults
// to what's still OPEN, and resolving a row removes it from that default view (it is
// never deleted — "Resolved"/"All" still show it, and it can be reopened).
import { useState } from "react";
import {
  listQualityReports,
  reportQualityIssue,
  setQualityReportStatus,
  type QualityReport,
  type QualityStatus,
} from "../../services/admin";
import { errorMessage } from "../../lib/errorMessage";
import { AdminPanel, AdminStatus } from "./AdminPanel";
import { useAdminResource } from "./useAdminResource";
import { formatDateTime } from "./format";

const VIEWS: { label: string; status?: QualityStatus }[] = [
  { label: "Open", status: "open" },
  { label: "Resolved", status: "resolved" },
  { label: "All" },
];

export function QualityPanel() {
  const [view, setView] = useState(0);
  const { data: reports, error, reload } = useAdminResource<QualityReport[]>(
    () => listQualityReports({ status: VIEWS[view].status }),
    [view],
  );

  const [input, setInput] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
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

  const toggleStatus = async (report: QualityReport) => {
    const next: QualityStatus = report.status === "open" ? "resolved" : "open";
    setBusyId(report.id);
    setMsg(null);
    setFormErr(null);
    try {
      await setQualityReportStatus({ id: report.id, status: next });
      setMsg(next === "resolved" ? `Resolved “${report.input}”.` : `Reopened “${report.input}”.`);
      reload();
    } catch (e) {
      setFormErr(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const ready = input.trim() !== "" && description.trim() !== "";

  return (
    <AdminPanel
      title="Quality reports"
      description="Log a translation that came back wrong: what you typed, and what was inaccurate about the result. Resolve one once it's been fixed."
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

      <div className="admin__filters">
        <div className="admin__seg">
          {VIEWS.map((v, i) => (
            <button
              key={v.label}
              type="button"
              className={`admin__seg-btn${view === i ? " admin__seg-btn--on" : ""}`}
              onClick={() => setView(i)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="admin__seg-btn" onClick={reload}>Refresh</button>
      </div>

      <AdminStatus error={formErr ?? error} pending={reports == null && formErr == null} />

      {reports && (
        <table className="admin__table">
          <thead>
            <tr><th>When</th><th>Input</th><th>Description</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {reports.length === 0 && (
              <tr>
                <td colSpan={5} className="admin__muted">
                  {VIEWS[view].status === "open"
                    ? "Nothing open. 🎉"
                    : "No quality reports yet."}
                </td>
              </tr>
            )}
            {reports.map((r) => (
              <tr key={r.id}>
                <td className="admin__nowrap">{formatDateTime(r.reportedAt)}</td>
                <td className="admin__bucket">{r.input}</td>
                <td>{r.description}</td>
                <td>
                  {r.status === "resolved" ? (
                    <span
                      className="admin__badge admin__badge--ok"
                      title={r.resolvedAt ? `Resolved ${formatDateTime(r.resolvedAt)}` : undefined}
                    >
                      resolved
                    </span>
                  ) : (
                    <span className="admin__badge">open</span>
                  )}
                </td>
                <td className="admin__nowrap">
                  <button
                    type="button"
                    className="admin__seg-btn"
                    disabled={busyId === r.id}
                    onClick={() => toggleStatus(r)}
                  >
                    {busyId === r.id ? "…" : r.status === "open" ? "Resolve" : "Reopen"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminPanel>
  );
}
