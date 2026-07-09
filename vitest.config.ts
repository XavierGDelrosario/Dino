import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The gated integration suite hits a REAL booted Supabase stack (Postgres + a
// locally-served edge function). That stack has transient, non-deterministic
// hiccups under CI boot/load — a cold-start edge 502, a slow round-trip — which
// red an otherwise-correct run (this is what turned a recent merge into
// re-run whack-a-mole). Retry the FAILING test a couple times so a transient
// infra blip self-heals; a REAL failure still fails every attempt, so nothing is
// masked. Also give integration a larger timeout (a cold round-trip to local
// Supabase can exceed the 5s default under load). Unit runs do no real I/O, so
// they keep retry=0 + the default timeout — this only applies with RUN_INTEGRATION=1.
const isIntegration = process.env.RUN_INTEGRATION === "1";

// Vitest config for the service-layer test suite.
//
// - Tests live under tests/ (mirroring src/); shared helpers in tests/support/.
// - `environment: node` — services are plain TS (no DOM); the UI is still stubs.
// - aliases: `@` → src (modules under test), `@test` → tests/support (helpers).
//   These mirror tsconfig.json's `paths` so editor/tsc and the runner agree.
// - `env` — satisfies config/supabaseClient.ts, which throws at import time when
//   VITE_SUPABASE_* are unset. The default unit suite never hits the network:
//   every service test either mocks config/supabaseClient or mocks the service's
//   dependencies, so these values only need to EXIST, not be real. But the gated
//   integration suite (RUN_INTEGRATION=1) DOES talk to a live local Supabase, so
//   fall back to the placeholders ONLY when the launcher hasn't supplied real
//   creds — otherwise a hardcoded `test.env` here would OVERRIDE the launcher's
//   process.env and hand the integration tests an invalid anon key (they'd fail
//   auth against local Supabase). Unit runs (no such env) are unchanged.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    retry: isIntegration ? 2 : 0,
    testTimeout: isIntegration ? 20000 : 5000,
    hookTimeout: isIntegration ? 20000 : 10000,
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? "test-anon-key",
    },
  },
  resolve: {
    alias: {
      "@test": resolvePath("./tests/support"),
      "@": resolvePath("./src"),
    },
  },
});
