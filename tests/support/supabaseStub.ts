// =========================================================
// Chainable Supabase client stub for service unit tests.
//
// The real client (config/supabaseClient) is a thenable query builder: every
// method (.select/.eq/.order/...) returns the builder, and the chain resolves
// to { data, error } when awaited (or via .single()/.maybeSingle()). This stub
// reproduces that shape with a Proxy so tests don't enumerate every method.
//
// Per table you QUEUE results in call order; each terminal (await, .single(),
// .maybeSingle()) shifts the next queued result for that table. Every method
// call is recorded in `calls` so a test can assert what was written.
//
// Usage (see any leaf-module *.test.ts):
//   const stub = createSupabaseStub();
//   stub.queueFrom("lists", { data: { list_id: "all" }, error: null });
//   // ...point config/supabaseClient at stub.client, then call the service.
// =========================================================
import { vi } from "vitest";

export interface StubResult {
  data: unknown;
  error: unknown;
}

export interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const EMPTY: StubResult = { data: null, error: null };

export function createSupabaseStub() {
  const queues = new Map<string, StubResult[]>();
  const calls: RecordedCall[] = [];
  const fromCalls: string[] = [];

  /** Queue one or more results for `table`, consumed in FIFO order. */
  function queueFrom(table: string, ...results: StubResult[]): void {
    const q = queues.get(table) ?? [];
    q.push(...results);
    queues.set(table, q);
  }

  function take(table: string): StubResult {
    return queues.get(table)?.shift() ?? EMPTY;
  }

  const from = vi.fn((table: string) => {
    fromCalls.push(table);

    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          // Thenable: resolve to the next queued result for this table. The
          // result is taken only when the then-callback runs (i.e. on await),
          // not when `.then` is merely accessed, so probing can't consume it.
          if (prop === "then") {
            return (onF: (v: StubResult) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.resolve(take(table)).then(onF, onR);
          }
          // Row-shaping terminals resolve to a single queued result.
          if (prop === "single" || prop === "maybeSingle") {
            return () => {
              calls.push({ table, method: String(prop), args: [] });
              return Promise.resolve(take(table));
            };
          }
          // Any other property is a chainable builder method.
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return builder;
          };
        },
      }
    );

    return builder;
  });

  // auth + functions are plain vi.fn()s tests configure directly.
  const auth = {
    getUser: vi.fn(),
    signInAnonymously: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const functions = {
    invoke: vi.fn(),
  };
  // RPC (Postgres functions, e.g. record_review): a plain mock that tests
  // configure with .mockResolvedValue({ data, error }) — services `await` it.
  const rpc = vi.fn();

  const client = { from, auth, functions, rpc };

  /** All recorded builder calls for a table (optionally a single method). */
  function callsFor(table: string, method?: string): RecordedCall[] {
    return calls.filter(
      (c) => c.table === table && (method === undefined || c.method === method)
    );
  }

  return { client, queueFrom, calls, callsFor, fromCalls, auth, functions, rpc };
}

export type SupabaseStub = ReturnType<typeof createSupabaseStub>;
