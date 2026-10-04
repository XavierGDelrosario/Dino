import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GOOGLE_RETURN_PATH,
  buildGoogleAuthUrl,
  captureGoogleReturnFromUrl,
  googleIdTokenEnabled,
  takeGoogleReturn,
} from "@/services/googleIdentity";
import { takeOAuthError } from "@/services/oauthReturn";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** A minimal `window` at `url`; replaceState records where the app was put back. */
function stubWindow(url: string) {
  const u = new URL(url);
  const replaceState = vi.fn((_state: unknown, _title: string, path: string) => {
    u.pathname = path;
    u.hash = "";
    u.search = "";
  });
  vi.stubGlobal("window", {
    location: {
      get origin() { return u.origin; },
      get pathname() { return u.pathname; },
      get hash() { return u.hash; },
      get search() { return u.search; },
    },
    history: { state: null, replaceState },
  });
  return { replaceState, path: () => u.pathname + u.search + u.hash };
}

/** Start an attempt and return what Google would echo back. */
async function begin(mode: "signin" | "signup") {
  stubWindow("https://app.test/" + mode);
  const url = new URL(await buildGoogleAuthUrl(mode));
  return { url, state: url.searchParams.get("state")! };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com");
  takeGoogleReturn(); // drain module state between cases
  takeOAuthError();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("googleIdTokenEnabled", () => {
  it("is on with a client id in a browser, off without one", () => {
    stubWindow("https://app.test/signin");
    expect(googleIdTokenEnabled()).toBe(true);
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    expect(googleIdTokenEnabled()).toBe(false);
  });
});

describe("buildGoogleAuthUrl", () => {
  it("asks Google for an ID token, returning to THIS origin, with the account chooser", async () => {
    const { url } = await begin("signin");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-123.apps.googleusercontent.com",
      redirect_uri: "https://app.test" + GOOGLE_RETURN_PATH,
      response_type: "id_token",
      scope: "openid email profile",
      prompt: "select_account",
    });
    // Google gets the HASH of the nonce; the raw value never leaves the browser.
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("refuses to build without a client id", async () => {
    stubWindow("https://app.test/signin");
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    await expect(buildGoogleAuthUrl("signin")).rejects.toThrow("not configured");
  });
});

describe("captureGoogleReturnFromUrl", () => {
  it("lifts the token out, strips the URL, and puts the user back on the starting page", async () => {
    const { url, state } = await begin("signup");
    const win = stubWindow(`https://app.test${GOOGLE_RETURN_PATH}#id_token=tok.en.sig&state=${encodeURIComponent(state)}`);

    captureGoogleReturnFromUrl();

    expect(win.path()).toBe("/signup");
    const back = takeGoogleReturn();
    expect(back?.mode).toBe("signup");
    expect(back?.credential.token).toBe("tok.en.sig");
    // The raw nonce handed to Supabase hashes to the one Google was given.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(back!.credential.nonce));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(url.searchParams.get("nonce"));
    // Once only, and the attempt is spent.
    expect(takeGoogleReturn()).toBeNull();
    expect(takeOAuthError()).toBeNull();
  });

  it("rejects a token whose state doesn't match the attempt (a crafted link)", async () => {
    await begin("signin");
    const win = stubWindow(`https://app.test${GOOGLE_RETURN_PATH}#id_token=evil&state=not-ours`);

    captureGoogleReturnFromUrl();

    expect(takeGoogleReturn()).toBeNull();
    expect(takeOAuthError()?.code).toBe("state_mismatch");
    expect(win.path()).toBe("/signin");
  });

  it("rejects a token when no attempt was started here", () => {
    const win = stubWindow(`https://app.test${GOOGLE_RETURN_PATH}#id_token=tok&state=x`);
    captureGoogleReturnFromUrl();
    expect(takeGoogleReturn()).toBeNull();
    expect(takeOAuthError()?.code).toBe("state_mismatch");
    expect(win.path()).toBe("/signin");
  });

  it("rejects a return that arrives after the attempt expired", async () => {
    vi.useFakeTimers();
    const { state } = await begin("signin");
    vi.advanceTimersByTime(16 * 60 * 1000);
    stubWindow(`https://app.test${GOOGLE_RETURN_PATH}#id_token=tok&state=${encodeURIComponent(state)}`);
    captureGoogleReturnFromUrl();
    expect(takeGoogleReturn()).toBeNull();
  });

  it("records Google's error and returns to the page — a cancel carries access_denied", async () => {
    const { state } = await begin("signup");
    const win = stubWindow(`https://app.test${GOOGLE_RETURN_PATH}#error=access_denied&state=${encodeURIComponent(state)}`);

    captureGoogleReturnFromUrl();

    expect(takeGoogleReturn()).toBeNull();
    expect(takeOAuthError()?.code).toBe("access_denied");
    expect(win.path()).toBe("/signup");
  });

  it("does nothing on any other page, even one carrying a token-like fragment", () => {
    const win = stubWindow("https://app.test/signin#id_token=tok&state=x");
    captureGoogleReturnFromUrl();
    expect(win.replaceState).not.toHaveBeenCalled();
    expect(takeGoogleReturn()).toBeNull();
  });

  it("opening /auth/google directly just lands on sign-in", () => {
    const win = stubWindow(`https://app.test${GOOGLE_RETURN_PATH}`);
    captureGoogleReturnFromUrl();
    expect(win.path()).toBe("/signin");
    expect(takeGoogleReturn()).toBeNull();
    expect(takeOAuthError()).toBeNull();
  });
});
