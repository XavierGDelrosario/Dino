// Minimal app shell — proves the Vite + React + TS toolchain runs.
// The service layer (session, lists, dictionary, ...) is built but not yet
// wired into views; that's the next step. Kept free of service imports so the
// scaffold runs even before Supabase env vars are configured.
export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>DINO 大脳</h1>
      <p>Scaffold is running. Next: wire the views to the service layer.</p>
    </main>
  );
}
