// Admin webpage (docs/TODO.md §8) — a privileged ops surface, NOT a normal user
// page. Access is server-enforced: getIsAdmin() asks the DB (is_admin RPC), and
// every data panel reads through an is_admin()-gated SECURITY DEFINER RPC, so the
// gate holds even if this component were rendered for a non-admin. Strings are
// plain English (internal tooling, deliberately outside the i18n catalog).
//
// Layout: a tab bar, one panel visible at a time. Each panel owns its own data
// fetch through an admin-gated RPC and (re)loads when its tab is selected. Add a
// panel = add an entry to TABS below.
import { useEffect, useState } from "react";
import { getIsAdmin } from "../services/admin";
import { errorMessage } from "../lib/errorMessage";
import { UsagePanel } from "../components/admin/UsagePanel";
import { ProviderHealthPanel } from "../components/admin/ProviderHealthPanel";
import { GrantsPanel } from "../components/admin/GrantsPanel";
import { ErrorLogPanel } from "../components/admin/ErrorLogPanel";
import { QualityPanel } from "../components/admin/QualityPanel";
import { TableSizesPanel } from "../components/admin/TableSizesPanel";
import { ErrorText } from "../components/common/ErrorText";
import "./admin.css";

type Gate = "checking" | "allowed" | "denied";

const TABS = [
  { key: "usage", label: "Usage", render: () => <UsagePanel /> },
  { key: "providers", label: "API health", render: () => <ProviderHealthPanel /> },
  { key: "grants", label: "Grants", render: () => <GrantsPanel /> },
  { key: "errors", label: "Errors", render: () => <ErrorLogPanel /> },
  { key: "quality", label: "Quality", render: () => <QualityPanel /> },
  { key: "tables", label: "DB size", render: () => <TableSizesPanel /> },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function AdminPage() {
  const [gate, setGate] = useState<Gate>("checking");
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("usage");

  useEffect(() => {
    let active = true;
    getIsAdmin()
      .then((ok) => active && setGate(ok ? "allowed" : "denied"))
      .catch((e) => {
        if (!active) return;
        setGate("denied");
        setErr(errorMessage(e));
      });
    return () => { active = false; };
  }, []);

  if (gate === "checking") return <section className="admin"><p className="admin__muted">Checking access…</p></section>;
  if (gate === "denied") {
    return (
      <section className="admin">
        <h2 className="admin__title">Admin</h2>
        <p className="admin__muted">You don’t have access to this page.</p>
        <ErrorText message={err} className="admin__error" />
      </section>
    );
  }

  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <section className="admin">
      <h2 className="admin__title">Admin</h2>

      <div className="admin__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`admin__tab${t.key === tab ? " admin__tab--on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* key forces a fresh mount per tab → each panel refetches on switch */}
      <div key={active.key}>{active.render()}</div>
    </section>
  );
}
