// TODO (review item #1): generate Supabase types here and use a typed client.
//
// Needs the Supabase CLI (more involved than a code-only change):
//   supabase gen types typescript --project-id <id> > src/types/database.types.ts
//   # or, against a local stack: supabase gen types typescript --local > ...
//
// Then in src/config/supabaseClient.ts:
//   import type { Database } from "../types/database.types";
//   createClient<Database>(url, anonKey)
//
// Once typed, delete the hand-written `…Row` interfaces and every
// `.select<string, RowType>(...)` cast in src/services/ — after that, a schema
// change (renamed/removed column) becomes a COMPILE error instead of a runtime
// surprise. The edge function's hand-mirrored row mapping can stay as-is
// (separate Deno runtime).
//
// Until generated, this file is intentionally an empty module.
export {};
