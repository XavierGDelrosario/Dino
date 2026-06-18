import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { getCurrentUserId, ensureSession, getUserProfile } from "@/services/session";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
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
