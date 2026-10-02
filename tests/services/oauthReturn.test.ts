import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseOAuthError,
  rememberOAuthIntent,
  recordOAuthError,
  takeOAuthError,
  onOAuthError,
} from "@/services/oauthReturn";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  takeOAuthError(); // drain module state between cases
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseOAuthError", () => {
  it("reads GoTrue's error from the FRAGMENT (web implicit flow)", () => {
    expect(
      parseOAuthError(
        "https://app.test/#error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked",
      ),
    ).toEqual({ code: "identity_already_exists", description: "Identity is already linked" });
  });

  it("reads it from the QUERY (native deep link)", () => {
    expect(
      parseOAuthError("com.example.app://auth-callback?error=access_denied&error_description=cancelled"),
    ).toEqual({ code: "access_denied", description: "cancelled" });
  });

  it("prefers error_code over the coarse error", () => {
    expect(parseOAuthError("https://a.test/?error=server_error&error_code=manual_linking_disabled")?.code)
      .toBe("manual_linking_disabled");
  });

  it("is null for a successful return and for junk", () => {
    expect(parseOAuthError("https://a.test/?code=abc")).toBeNull();
    expect(parseOAuthError("https://a.test/#access_token=x")).toBeNull();
    expect(parseOAuthError("not a url")).toBeNull();
  });
});

describe("intent + pending error", () => {
  it("attaches the remembered intent to the error, once", () => {
    rememberOAuthIntent({ mode: "signup", provider: "google" });
    const err = recordOAuthError("identity_already_exists", null);
    expect(err.intent).toMatchObject({ mode: "signup", provider: "google" });

    expect(takeOAuthError()).toBe(err);
    expect(takeOAuthError()).toBeNull();
    // The intent is consumed too, so a later unrelated error can't inherit it.
    expect(recordOAuthError("x", null).intent).toBeNull();
  });

  it("drops a STALE intent (an abandoned attempt must not label a later error)", () => {
    vi.useFakeTimers();
    rememberOAuthIntent({ mode: "signin", provider: "apple" });
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(recordOAuthError("server_error", null).intent).toBeNull();
  });

  it("notifies subscribers (native: the page is already mounted)", () => {
    const fn = vi.fn();
    const off = onOAuthError(fn);
    recordOAuthError("access_denied", null);
    off();
    recordOAuthError("access_denied", null);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
