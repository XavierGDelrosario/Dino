// =========================================================
// Public surface of the translation module.
//
// Only a thin client that calls the `translate` Edge Function. The actual
// provider call is server-only (supabase/functions/translate) — the frontend
// can never translate on its own. The provider (DeepL/Google/other) is not yet
// decided for the POC and is isolated to the edge function.
// =========================================================

export * from "./client";
