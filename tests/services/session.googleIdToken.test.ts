import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));
vi.mock("@/services/captcha", () => ({
  getCaptchaToken: vi.fn(async () => undefined),
  captchaEnabled: vi.fn(() => false),
}));

import { linkGoogleIdToken, signInWithGoogleIdToken, hasPendingGuestMerge } from "@/services/session";
import { emailFromIdToken, makeNonce } from "@/services/googleIdentity";

let stub: SupabaseStub;
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
const credential = { token: "google-id-token", nonce: "raw-nonce" };

beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("linkGoogleIdToken", () => {
  it("links the token to the CURRENT user (same uid) with the raw nonce", async () => {
    stub.auth.linkIdentity.mockResolvedValue({
      data: { user: { id: "guest-1", email: "a@gmail.com", is_anonymous: false } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    const status = await linkGoogleIdToken(credential);

    expect(stub.auth.linkIdentity).toHaveBeenCalledWith({
      provider: "google",
      token: "google-id-token",
      nonce: "raw-nonce",
    });
    expect(status).toEqual({ userId: "guest-1", email: "a@gmail.com", isAnonymous: false });
    // A link keeps the uid, so there is nothing to merge.
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it("keeps GoTrue's code on failure, so the page can fall back to signing in", async () => {
    stub.auth.linkIdentity.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Identity is already linked to another user", code: "identity_already_exists" },
    });
    await expect(linkGoogleIdToken(credential)).rejects.toMatchObject({ code: "identity_already_exists" });
  });
});

describe("signInWithGoogleIdToken", () => {
  it("mints the guest's merge ticket BEFORE switching to the Google account", async () => {
    stub.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: "guest-1", is_anonymous: true } } },
      error: null,
    });
    const order: string[] = [];
    stub.rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return { data: "tok-1", error: null };
    });
    stub.auth.signInWithIdToken.mockImplementation(async () => {
      order.push("signInWithIdToken");
      return { data: { user: { id: "acct-1", email: "a@gmail.com" } }, error: null };
    });
    stub.queueFrom("users", { data: null, error: null });

    const status = await signInWithGoogleIdToken(credential);

    expect(order).toEqual(["create_guest_merge_ticket", "signInWithIdToken"]);
    expect(stub.auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: "google",
      token: "google-id-token",
      nonce: "raw-nonce",
      options: { captchaToken: undefined },
    });
    expect(status).toEqual({ userId: "acct-1", email: "a@gmail.com", isAnonymous: false });
    expect(hasPendingGuestMerge()).toBe(true);
  });

  it("throws a ServiceError carrying the code when Supabase rejects the token", async () => {
    stub.auth.signInWithIdToken.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Database error saving new user", code: "unexpected_failure" },
    });
    await expect(signInWithGoogleIdToken(credential)).rejects.toMatchObject({ code: "unexpected_failure" });
  });
});

describe("emailFromIdToken", () => {
  const jwt = (claims: object) => {
    const b64url = (s: string) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
  };

  it("reads the email claim, including non-ASCII payloads", () => {
    expect(emailFromIdToken(jwt({ email: "me@gmail.com", name: "山田 太郎" }))).toBe("me@gmail.com");
  });

  it("is null when there is no email or the token is junk", () => {
    expect(emailFromIdToken(jwt({ sub: "123" }))).toBeNull();
    expect(emailFromIdToken("not-a-jwt")).toBeNull();
    expect(emailFromIdToken("")).toBeNull();
  });
});

describe("makeNonce", () => {
  it("gives Google the SHA-256 hex of the raw value Supabase is given", async () => {
    const { raw, hashed } = await makeNonce();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hashed).toBe(hex);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is different every time", async () => {
    const [a, b] = await Promise.all([makeNonce(), makeNonce()]);
    expect(a.raw).not.toBe(b.raw);
  });
});
