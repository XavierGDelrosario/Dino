import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));
vi.mock("@/services/captcha", () => ({
  getCaptchaToken: vi.fn(async () => undefined),
  captchaEnabled: vi.fn(() => false),
}));

import { needsTermsAcceptance, recordTermsAgreement } from "@/services/session";
import { CURRENT_TERMS_VERSION, termsOutdated } from "@/lib/terms";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

const profileWith = (terms_version: string | null) => ({
  data: {
    user_id: "u1", email: "a@b.com", date_created: "2026-01-01", native_language: "EN",
    learning_language: "JA", terms_agreed_at: null, terms_version,
  },
  error: null,
});

describe("termsOutdated", () => {
  it("is an ORDERING: older or missing is outdated, the same or NEWER is not", () => {
    expect(termsOutdated(null)).toBe(true);
    expect(termsOutdated(undefined)).toBe(true);
    expect(termsOutdated("2020-01-01")).toBe(true);
    expect(termsOutdated(CURRENT_TERMS_VERSION)).toBe(false);
    // Stamped by a newer build than this one — accepted, not "different".
    expect(termsOutdated("2999-12-31")).toBe(false);
  });
});

describe("needsTermsAcceptance", () => {
  it("does not re-prompt an account a NEWER build already stamped", async () => {
    stub.queueFrom("users", profileWith("2999-12-31"));
    expect(await needsTermsAcceptance("u1")).toBe(false);
  });

  it("prompts for an older stamp, a missing stamp, and a missing row", async () => {
    stub.queueFrom("users", profileWith("2020-01-01"));
    expect(await needsTermsAcceptance("u1")).toBe(true);
    stub.queueFrom("users", profileWith(null));
    expect(await needsTermsAcceptance("u1")).toBe(true);
    stub.queueFrom("users", { data: null, error: null });
    expect(await needsTermsAcceptance("u1")).toBe(true);
  });
});

describe("recordTermsAgreement", () => {
  it("only stamps a row with no acceptance or an OLDER one — never moves it backwards", async () => {
    stub.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    stub.queueFrom("users", { data: null, error: null });

    await recordTermsAgreement();

    const update = stub.callsFor("users").find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ terms_version: CURRENT_TERMS_VERSION });
    const guard = stub.callsFor("users").find((c) => c.method === "or");
    expect(guard?.args[0]).toBe(`terms_version.is.null,terms_version.lt.${CURRENT_TERMS_VERSION}`);
  });
});
