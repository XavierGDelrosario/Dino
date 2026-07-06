// The panel shell every admin panel repeated: a `<section>` with a title and a
// muted description line. Panel-specific content (forms, tables) is the children,
// so each panel keeps its own internal layout. AdminStatus renders the equally
// repeated error line + "Loading…" placeholder.
import type { ReactNode } from "react";
import { ErrorText } from "../common/ErrorText";

export function AdminPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="admin__panel">
      <h3 className="admin__panel-title">{title}</h3>
      {description && <p className="admin__muted">{description}</p>}
      {children}
    </section>
  );
}

/** The recurring `{error && <pre>} {pending && "Loading…"}` pair. `pending` is
 *  typically `data == null` from useAdminResource. */
export function AdminStatus({ error, pending }: { error: string | null; pending: boolean }) {
  return (
    <>
      <ErrorText message={error} className="admin__error" />
      {pending && !error && <p className="admin__muted">Loading…</p>}
    </>
  );
}
