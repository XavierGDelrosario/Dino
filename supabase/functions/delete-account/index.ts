// =========================================================
// `delete-account` Edge Function — COMPLETE account erasure (#13).
//
// The DB `delete_account()` RPC erases the caller's PUBLIC-schema data (cascades
// users → user_words/lists/list_words/review_log/limits/usage) but CANNOT remove
// the Supabase `auth.users` row — clients have no admin API, and deleting the auth
// row needs the service role. Without this, a "deleted" user can still sign in and
// their email stays registered. This function closes that gap in two steps:
//   1. run delete_account() with the USER's JWT (SECURITY DEFINER, scoped to
//      auth.uid()) → public data gone;
//   2. auth.admin.deleteUser(uid) with the SERVICE ROLE → the auth identity gone.
// Public data is deleted FIRST: if step 2 failed afterwards we'd leave only an
// empty auth row (re-creatable), never orphaned user data.
//
// verify_jwt is ON (gateway-validated), so only an authenticated caller reaches
// here; they can only delete THEMSELVES (uid comes from their own token).
// Auto-provided env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Optional: ALLOWED_ORIGINS (shared project secret, same as translate).
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allowOrigin = allowed.length === 0
    ? "*"
    : allowed.includes(origin ?? "")
      ? (origin as string)
      : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/** Caller's uid from the JWT `sub` (signature already verified by the gateway). */
function userIdFromAuth(authHeader: string | null): string | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED = parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS"));

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"), ALLOWED);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);

  const authHeader = req.headers.get("Authorization");
  const uid = userIdFromAuth(authHeader);
  if (!authHeader || !uid) return json({ error: "unauthorized" }, 401, cors);

  // 1. Erase the caller's public-schema data (RPC runs as them via their JWT).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: rpcErr } = await userClient.rpc("delete_account");
  if (rpcErr) return json({ error: "could not delete account data" }, 500, cors);

  // 2. Remove the auth identity (service role; clients can't).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: authErr } = await admin.auth.admin.deleteUser(uid);
  if (authErr) return json({ error: "could not delete auth user" }, 500, cors);

  return json({ deleted: true }, 200, cors);
});
