// @vitest-environment jsdom
// Spec for the Turnstile captcha token provider (services/captcha.ts). Needs a DOM:
// the module injects a <script> and renders a throwaway widget into document.body.
//
// The sitekey is read at MODULE LOAD (a top-level const), so every case stubs
// VITE_TURNSTILE_SITE_KEY and then dynamically imports a FRESH module — a static
// top-level import would bake in whatever the env was at first load.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ServiceErrorKind } from "@/services/errors";

// `instanceof ServiceError` can't be used here: vi.resetModules() re-evaluates
// errors.ts for each dynamic import, so the class the fresh captcha module throws
// is a DIFFERENT identity from any statically-imported one. Assert on the shape.
async function rejectionKind(promise: Promise<unknown>): Promise<ServiceErrorKind> {
  try {
    await promise;
  } catch (e) {
    return (e as { kind: ServiceErrorKind }).kind;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

type RenderOptions = {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback": () => void;
  "timeout-callback"?: () => void;
};

// Stand-in for the script Cloudflare would serve: records what it was rendered with
// and lets each test drive the outcome (success / error / silence).
function installTurnstile() {
  const rendered: RenderOptions[] = [];
  const removed: string[] = [];
  const api = {
    render: vi.fn((_el: HTMLElement, options: RenderOptions) => {
      rendered.push(options);
      return `widget-${rendered.length}`;
    }),
    remove: vi.fn((id: string) => void removed.push(id)),
  };
  // The real script tag sets window.turnstile; jsdom doesn't fetch it, so emulate
  // that by defining the global when the injected script's onload is fired.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLScriptElement) {
          window.turnstile = api;
          node.onload?.(new Event("load"));
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
  return { api, rendered, removed, stop: () => observer.disconnect() };
}

async function loadCaptcha(siteKey?: string) {
  vi.resetModules();
  if (siteKey) vi.stubEnv("VITE_TURNSTILE_SITE_KEY", siteKey);
  else vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
  return import("@/services/captcha");
}

let turnstile: ReturnType<typeof installTurnstile>;

beforeEach(() => {
  turnstile = installTurnstile();
});

afterEach(() => {
  turnstile.stop();
  delete window.turnstile;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

describe("captchaEnabled", () => {
  it("is off without a sitekey and on with one", async () => {
    expect((await loadCaptcha()).captchaEnabled()).toBe(false);
    expect((await loadCaptcha("1x00000000000000000000BB")).captchaEnabled()).toBe(true);
  });
});

describe("getCaptchaToken", () => {
  it("resolves undefined and loads NOTHING when no sitekey is configured", async () => {
    // The default build: no key, so the auth calls send no token and the whole
    // Cloudflare script is never even fetched.
    const { getCaptchaToken } = await loadCaptcha();

    expect(await getCaptchaToken()).toBeUndefined();
    expect(document.head.querySelector("script")).toBeNull();
    expect(turnstile.api.render).not.toHaveBeenCalled();
  });

  it("mints a token from the invisible widget when a sitekey is configured", async () => {
    const { getCaptchaToken } = await loadCaptcha("1x00000000000000000000BB");

    const pending = getCaptchaToken();
    await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(1));
    turnstile.rendered[0].callback("tok-1");

    expect(await pending).toBe("tok-1");
    expect(turnstile.rendered[0].sitekey).toBe("1x00000000000000000000BB");
  });

  it("removes the widget and its container after each call (tokens are single-use)", async () => {
    const { getCaptchaToken } = await loadCaptcha("1x00000000000000000000BB");

    const pending = getCaptchaToken();
    await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(1));
    const container = document.body.firstElementChild;
    expect(container).not.toBeNull(); // the off-screen host is in the DOM while solving
    turnstile.rendered[0].callback("tok-1");
    await pending;

    expect(turnstile.removed).toEqual(["widget-1"]);
    expect(document.body.contains(container!)).toBe(false);
  });

  it("throws when the challenge fails, rather than signing in with no token", async () => {
    // The always-fails sitekey (2x…BB) drives this path for real, locally.
    const { getCaptchaToken } = await loadCaptcha("2x00000000000000000000BB");

    const pending = getCaptchaToken();
    const rejected = rejectionKind(pending);
    await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(1));
    turnstile.rendered[0]["error-callback"]();

    expect(await rejected).toBe("permission");
    expect(turnstile.removed).toEqual(["widget-1"]); // still cleaned up
  });

  it("times out instead of hanging the app forever behind a silent widget", async () => {
    vi.useFakeTimers();
    try {
      const { getCaptchaToken } = await loadCaptcha("1x00000000000000000000BB");

      const pending = getCaptchaToken();
      const rejected = rejectionKind(pending);
      await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(15_000); // widget never calls back

      expect(await rejected).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects the Cloudflare script once, however many tokens are minted", async () => {
    const { getCaptchaToken } = await loadCaptcha("1x00000000000000000000BB");

    const first = getCaptchaToken();
    await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(1));
    turnstile.rendered[0].callback("tok-1");
    await first;

    const second = getCaptchaToken();
    await vi.waitFor(() => expect(turnstile.rendered).toHaveLength(2));
    turnstile.rendered[1].callback("tok-2");

    expect(await second).toBe("tok-2");
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });
});
