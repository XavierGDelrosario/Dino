// @vitest-environment jsdom
// The session hook's two status sources — the bootstrap read and the auth listener —
// must agree on who wins when a sign-in lands between them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

type Listener = (event: string, session: { user: { id: string; email?: string; is_anonymous?: boolean } } | null) => void;
const { auth } = vi.hoisted(() => ({ auth: { listener: null as Listener | null } }));

vi.mock("@/config/supabaseClient", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (fn: Listener) => {
        auth.listener = fn;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  },
}));
vi.mock("@/services/nativeAuth", () => ({ registerNativeAuthListener: vi.fn(async () => () => {}) }));
vi.mock("@/services/session", () => ({
  ensureSession: vi.fn(),
  getAuthStatus: vi.fn(),
  hasPendingGuestMerge: vi.fn(() => false),
  claimGuestMerge: vi.fn(async () => 0),
}));

import { useSession } from "@/hooks/useSession";
import { ensureSession, getAuthStatus } from "@/services/session";

const guest = { userId: "guest-1", email: null, isAnonymous: true };

beforeEach(() => {
  vi.clearAllMocks();
  auth.listener = null;
  vi.mocked(ensureSession).mockResolvedValue("guest-1");
});

describe("useSession", () => {
  it("boots as the stored guest", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(guest);
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ userId: "guest-1", isAnonymous: true });
  });

  it("a sign-in that lands while the bootstrap is still reading is NOT undone by it", async () => {
    let finishBootstrap!: (s: typeof guest) => void;
    vi.mocked(getAuthStatus).mockReturnValue(new Promise((resolve) => { finishBootstrap = resolve; }));
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(auth.listener).not.toBeNull());

    // The listener reports the stored guest (the auth page mounts on this)…
    act(() => auth.listener!("INITIAL_SESSION", { user: { id: "guest-1", is_anonymous: true } }));
    expect(result.current.userId).toBe("guest-1");
    // …the page finishes a Google sign-in…
    act(() => auth.listener!("SIGNED_IN", { user: { id: "acct-1", email: "a@gmail.com" } }));
    expect(result.current).toMatchObject({ userId: "acct-1", isAnonymous: false });

    // …and only then does the bootstrap's read, made as the guest, come back.
    await act(async () => { finishBootstrap(guest); });
    expect(result.current).toMatchObject({ userId: "acct-1", email: "a@gmail.com", isAnonymous: false });
  });

  it("the bootstrap still refreshes the SAME user's details", async () => {
    let finishBootstrap!: (s: { userId: string; email: string | null; isAnonymous: boolean }) => void;
    vi.mocked(getAuthStatus).mockReturnValue(new Promise((resolve) => { finishBootstrap = resolve; }));
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(auth.listener).not.toBeNull());

    act(() => auth.listener!("INITIAL_SESSION", { user: { id: "acct-1", email: "old@x.com" } }));
    await act(async () => { finishBootstrap({ userId: "acct-1", email: "new@x.com", isAnonymous: false }); });
    expect(result.current.email).toBe("new@x.com");
  });
});
