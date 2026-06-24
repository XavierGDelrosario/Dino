// Best-effort human-readable string from a thrown value. Supabase (and PostgREST)
// throw plain { message, code, ... } objects, not Errors, so cover both. Shared by
// the hooks and components that surface an error to the UI.
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (m !== undefined && m !== null && m !== "") return String(m);
  }
  return String(e);
}
