// =========================================================
// Supabase browser client (singleton).
//
// Uses the public anon key — safe to ship to the browser because every table
// is guarded by Row Level Security keyed on auth.uid(). Privileged work (the
// translation provider, writing verified words) happens in edge functions with
// the service-role key, never here.
//
// Env (Vite): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
// =========================================================

import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set"
  );
}

// OUTPUT: a configured anon SupabaseClient (singleton).
// CONSTRAINTS: throws at import time if VITE_SUPABASE_URL / ANON_KEY are unset.
export const supabase = createClient(url, anonKey);
