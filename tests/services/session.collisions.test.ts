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

import {
  collisionKind,
  getSignInMethods,
  requestPasswordReset,
  signIn,
  claimGuestMerge,
  hasPendingGuestMerge,
} from "@/services/session";
import { ServiceError } from "@/services/errors";

let stub: SupabaseStub;
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
function sessionAs(user: { id: string; is_anonymous?: boolean }) {
  stub.auth.getSession.mockResolvedValue({ data: { session: { user } }, error: null });
}

beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("collisionKind", () => {
  it("classifies GoTrue's codes, whether raw or wrapped in a ServiceError", () => {
    expect(collisionKind({ code: "email_exists" })).toBe("account_exists");
    expect(collisionKind({ code: "user_already_exists" })).toBe("account_exists");
    expect(collisionKind(new ServiceError("x", "unknown", { code: "email_exists" }))).toBe("account_exists");
    expect(collisionKind({ code: "invalid_credentials" })).toBe("bad_credentials");
  });

  it("is null for everything else", () => {
    expect(collisionKind({ code: "23505" })).toBeNull();
    expect(collisionKind(new Error("boom"))).toBeNull();
    expect(collisionKind(null)).toBeNull();
  });
});

describe("getSignInMethods", () => {
  it("normalizes the email and keeps only known methods, in order", async () => {
    stub.rpc.mockResolvedValue({ data: ["google", "saml", "email"], error: null });
    expect(await getSignInMethods("  Me@X.com ")).toEqual(["google", "email"]);
    expect(stub.rpc).toHaveBeenCalledWith("sign_in_methods", { p_email: "me@x.com" });
  });

  it("reads an RPC failure as 'don't know' rather than throwing over the real error", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect(await getSignInMethods("a@b.com")).toEqual([]);
  });
});

describe("guest → account merge", () => {
  it("a GUEST signing in mints a ticket BEFORE the uid switches", async () => {
    sessionAs({ id: "guest-1", is_anonymous: true });
    const order: string[] = [];
    stub.rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return { data: "tok-1", error: null };
    });
    stub.auth.signInWithPassword.mockImplementation(async () => {
      order.push("signInWithPassword");
      return { data: { user: { id: "acct-1", email: "a@b.com" } }, error: null };
    });
    stub.queueFrom("users", { data: null, error: null });

    await signIn({ email: "a@b.com", password: "pw12345678" });

    expect(order).toEqual(["create_guest_merge_ticket", "signInWithPassword"]);
    expect(hasPendingGuestMerge()).toBe(true);
  });

  it("requesting a reset link mints the ticket too — following it replaces the guest", async () => {
    sessionAs({ id: "guest-1", is_anonymous: true });
    stub.rpc.mockResolvedValue({ data: "tok-1", error: null });
    stub.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

    await requestPasswordReset("a@b.com");

    expect(stub.rpc).toHaveBeenCalledWith("create_guest_merge_ticket");
    expect(hasPendingGuestMerge()).toBe(true);
  });

  it("stores no ticket when the guest has nothing to carry (RPC returns null)", async () => {
    sessionAs({ id: "guest-1", is_anonymous: true });
    stub.rpc.mockResolvedValue({ data: null, error: null });
    stub.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "acct-1", email: "a@b.com" } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    await signIn({ email: "a@b.com", password: "pw12345678" });
    expect(hasPendingGuestMerge()).toBe(false);
  });

  it("an ACCOUNT switching accounts mints nothing (only guests carry words)", async () => {
    sessionAs({ id: "acct-0", is_anonymous: false });
    stub.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "acct-1", email: "a@b.com" } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    await signIn({ email: "a@b.com", password: "pw12345678" });
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it("claims once as the account, then the ticket is spent", async () => {
    localStorage.setItem("dino.guestMerge", JSON.stringify({ token: "tok-1", at: Date.now() }));
    sessionAs({ id: "acct-1", is_anonymous: false });
    stub.rpc.mockResolvedValue({ data: 7, error: null });

    const [a, b] = await Promise.all([claimGuestMerge(), claimGuestMerge()]); // shared in-flight
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(stub.rpc).toHaveBeenCalledTimes(1);
    expect(stub.rpc).toHaveBeenCalledWith("claim_guest_merge", { p_token: "tok-1" });
    expect(hasPendingGuestMerge()).toBe(false);
    expect(await claimGuestMerge()).toBe(0);
  });

  it("keeps the ticket while still the guest (the switch hasn't landed yet)", async () => {
    localStorage.setItem("dino.guestMerge", JSON.stringify({ token: "tok-1", at: Date.now() }));
    sessionAs({ id: "guest-1", is_anonymous: true });

    expect(await claimGuestMerge()).toBe(0);
    expect(stub.rpc).not.toHaveBeenCalled();
    expect(hasPendingGuestMerge()).toBe(true);
  });

  it("ignores an expired ticket", async () => {
    localStorage.setItem("dino.guestMerge", JSON.stringify({ token: "tok-1", at: Date.now() - 2 * 3600_000 }));
    expect(hasPendingGuestMerge()).toBe(false);
  });

  it("never throws: a failed claim returns 0", async () => {
    localStorage.setItem("dino.guestMerge", JSON.stringify({ token: "tok-1", at: Date.now() }));
    sessionAs({ id: "acct-1", is_anonymous: false });
    stub.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await claimGuestMerge()).toBe(0);
  });
});
