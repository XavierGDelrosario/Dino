import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

// Captcha is OFF in this suite by default (no sitekey → undefined token), matching a
// build with no VITE_TURNSTILE_SITE_KEY. The captcha describe-block below drives it on.
vi.mock("@/services/captcha", () => ({
  getCaptchaToken: vi.fn(async () => undefined),
  captchaEnabled: vi.fn(() => false),
}));

import { getCurrentUserId, ensureSession, getUserProfile, signIn, requestPasswordReset } from "@/services/session";
import { getCaptchaToken } from "@/services/captcha";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  vi.mocked(getCaptchaToken).mockResolvedValue(undefined);
});

describe("getCurrentUserId", () => {
  it("returns the current user id", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    expect(await getCurrentUserId()).toBe("u1");
  });

  it("returns null when there is no session", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: null } });
    expect(await getCurrentUserId()).toBeNull();
  });
});

describe("ensureSession", () => {
  it("uses the existing session and upserts the users row (no anon sign-in)", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "real@x.com" } } });
    stub.queueFrom("users", { data: null, error: null }); // profile upsert

    expect(await ensureSession()).toBe("u1");
    expect(stub.auth.signInAnonymously).not.toHaveBeenCalled();
    const upsert = stub.callsFor("users", "upsert")[0];
    expect(upsert?.args[0]).toEqual({ user_id: "u1", email: "real@x.com" });
  });

  it("signs in anonymously and synthesizes a guest email when there is no session", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: null } });
    stub.auth.signInAnonymously.mockResolvedValue({
      data: { user: { id: "guest-1", email: null } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    expect(await ensureSession()).toBe("guest-1");
    const upsert = stub.callsFor("users", "upsert")[0];
    expect(upsert?.args[0]).toEqual({ user_id: "guest-1", email: "guest-1@guest.dino" });
  });

  it("self-heals a stale session (getUser errors) by signing out and re-signing in", async () => {
    // localStorage held a token for a wiped user → getUser rejects it.
    stub.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "user not found" },
    });
    stub.auth.signInAnonymously.mockResolvedValue({
      data: { user: { id: "fresh-guest", email: null } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    expect(await ensureSession()).toBe("fresh-guest");
    expect(stub.auth.signOut).toHaveBeenCalled(); // purged the stale session
    expect(stub.auth.signInAnonymously).toHaveBeenCalled();
  });

  it("synthesizes a unique guest email when the anon email is EMPTY STRING (not null)", async () => {
    // Supabase anonymous users carry email "" — must still synthesize, else every
    // guest collides on the users_email unique constraint (23505).
    stub.auth.getUser.mockResolvedValue({ data: { user: { id: "guest-2", email: "" } } });
    stub.queueFrom("users", { data: null, error: null });

    await ensureSession();
    const upsert = stub.callsFor("users", "upsert")[0];
    expect(upsert?.args[0]).toEqual({ user_id: "guest-2", email: "guest-2@guest.dino" });
  });

  it("throws when anonymous sign-in fails", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: null } });
    stub.auth.signInAnonymously.mockResolvedValue({
      data: { user: null },
      error: new Error("anon disabled"),
    });
    await expect(ensureSession()).rejects.toThrow("anon disabled");
  });
});

describe("getUserProfile", () => {
  it("maps a row to a UserProfile", async () => {
    stub.queueFrom("users", {
      data: { user_id: "u1", email: "a@b.com", date_created: "2026-06-01" },
      error: null,
    });
    expect(await getUserProfile("u1")).toEqual({
      userId: "u1",
      email: "a@b.com",
      dateCreated: "2026-06-01",
    });
  });

  it("returns null when there is no row", async () => {
    stub.queueFrom("users", { data: null, error: null });
    expect(await getUserProfile("u1")).toBeNull();
  });
});

// Captcha (anti-sybil, 2026-06-28 audit). Once the project's [auth.captcha] is on,
// the server REJECTS these calls without a token — so the token must actually reach
// each of the three endpoints GoTrue gates. (upgradeToAccount is deliberately absent:
// updateUser is not captcha-gated, and its session already passed the anon check.)
describe("captcha token", () => {
  it("passes the token to anonymous sign-in — the call that mints a user per visitor", async () => {
    vi.mocked(getCaptchaToken).mockResolvedValue("tok-anon");
    stub.auth.getUser.mockResolvedValue({ data: { user: null } });
    stub.auth.signInAnonymously.mockResolvedValue({
      data: { user: { id: "guest-1", email: null } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    await ensureSession();

    expect(stub.auth.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: "tok-anon" },
    });
  });

  it("passes the token to password sign-in", async () => {
    vi.mocked(getCaptchaToken).mockResolvedValue("tok-signin");
    stub.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", email: "a@b.com" } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    await signIn({ email: "A@b.com ", password: "pw" });

    expect(stub.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "pw",
      options: { captchaToken: "tok-signin" },
    });
  });

  it("passes the token to the password-reset email request", async () => {
    vi.mocked(getCaptchaToken).mockResolvedValue("tok-reset");
    stub.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

    await requestPasswordReset("A@b.com");

    const [email, options] = stub.auth.resetPasswordForEmail.mock.calls[0];
    expect(email).toBe("a@b.com");
    expect(options.captchaToken).toBe("tok-reset");
  });

  it("sends NO token when captcha is off, leaving the auth calls as they were", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: null } });
    stub.auth.signInAnonymously.mockResolvedValue({
      data: { user: { id: "guest-1", email: null } },
      error: null,
    });
    stub.queueFrom("users", { data: null, error: null });

    await ensureSession();

    expect(stub.auth.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: undefined },
    });
  });
});
