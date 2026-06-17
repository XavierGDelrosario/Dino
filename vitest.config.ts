import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Vitest config for the service-layer test suite.
//
// - Tests live under tests/ (mirroring src/); shared helpers in tests/support/.
// - `environment: node` — services are plain TS (no DOM); the UI is still stubs.
// - aliases: `@` → src (modules under test), `@test` → tests/support (helpers).
//   These mirror tsconfig.json's `paths` so editor/tsc and the runner agree.
// - `env` — satisfies config/supabaseClient.ts, which throws at import time when
//   VITE_SUPABASE_* are unset. Tests never hit the network: every service test
//   either mocks config/supabaseClient or mocks the service's dependencies, so
//   these values only need to exist, not be real.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY: "test-anon-key",
    },
  },
  resolve: {
    alias: {
      "@test": resolvePath("./tests/support"),
      "@": resolvePath("./src"),
    },
  },
});
