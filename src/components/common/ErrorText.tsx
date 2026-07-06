// The recurring inline error line: `{msg && <pre className="…__error">{msg}</pre>}`.
// Renders nothing when there's no message. Defaults to the app's form/view error
// style; pass `className="admin__error"` (etc.) where a different style applies.
export function ErrorText({
  message,
  className = "review__error",
}: {
  message?: string | null;
  className?: string;
}) {
  if (!message) return null;
  return <pre className={className}>{message}</pre>;
}
