// When did an offline review actually happen?
//
// `record_review` stamps now() on the SERVER on purpose — review_log is the FSRS
// training set, so history must not be forgeable. Replaying an offline grade breaks
// that: a review done Monday and synced Friday would be recorded as Friday, and
// `elapsed_days` — measured from last_reviewed_date to the stamp — comes out days too
// long. The interval it produces is then wrong, and wrong in the direction that makes
// the scheduler think you remembered something for far longer than you did.
//
// The obvious fix, sending Date.now(), is worse than it looks: a device clock can be
// wrong, and can be CHANGED mid-session, so the timestamp is neither trustworthy nor
// stable.
//
// So this never reads the wall clock. It anchors to a SERVER instant captured while
// online, and measures forward from it with a MONOTONIC clock:
//
//     reviewedAt = anchor.serverNow + (mono() - anchor.mono)
//
// `performance.now()` counts from an arbitrary origin and does not jump when the system
// clock is set — so changing the clock mid-session cannot move a review. The instant is
// computed at GRADE time and stored with the queued grade, so a clock change (or an app
// restart) afterwards cannot retroactively alter it either.
//
// PURE: `mono` and the anchor are injected, which is also how the tests move time.

/** A server instant, paired with the monotonic reading taken at the same moment. */
export interface ClockAnchor {
  /** Server epoch ms, from a response while online. Authoritative. */
  serverNow: number;
  /** performance.now() sampled at the same moment. Origin is arbitrary; only deltas matter. */
  mono: number;
}

/** The monotonic clock. Injectable so tests can advance it without touching Date. */
export type MonotonicClock = () => number;

export const defaultMono: MonotonicClock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : // A runtime with no performance.now (old WebView, some test envs). Date.now is a
      // poor monotonic clock, but the anchor still bounds the error to one session.
      Date.now();

/** Capture an anchor. Call this with a SERVER timestamp, never a local one. */
export function anchorAt(serverNow: number, mono: MonotonicClock = defaultMono): ClockAnchor {
  return { serverNow, mono: mono() };
}

/**
 * The instant "now" maps to, in server time. Monotonic-derived, so a wall-clock change
 * between the anchor and this call cannot move the result.
 */
export function reviewedAtFrom(anchor: ClockAnchor, mono: MonotonicClock = defaultMono): number {
  // Monotonic clocks do not go backwards, but a runtime that fell back to Date.now()
  // above has no such guarantee — clamp so a backwards jump can never produce an
  // instant BEFORE the anchor, which would read as a review that predates its own deck.
  const elapsed = Math.max(0, mono() - anchor.mono);
  return anchor.serverNow + elapsed;
}

/**
 * A stamp for a grade, as an ISO string for the server, plus whether it is trustworthy.
 *
 * `approx` marks the degraded case: a cold start found queued grades but no anchor (the
 * app was killed and relaunched offline), so there is no server instant to measure from
 * and the only option left is the local clock. The server clamps either way; this flag
 * exists so a replay can be told apart in the log rather than silently blending in.
 */
export interface ReviewStamp {
  reviewedAt: string;
  approx: boolean;
}

export function stampFor(
  anchor: ClockAnchor | null,
  mono: MonotonicClock = defaultMono,
  wallNow: () => number = Date.now,
): ReviewStamp {
  if (!anchor) return { reviewedAt: new Date(wallNow()).toISOString(), approx: true };
  return { reviewedAt: new Date(reviewedAtFrom(anchor, mono)).toISOString(), approx: false };
}

// ── The live anchor ─────────────────────────────────────────────────────────
// Held IN MEMORY, never persisted, and that is a correctness requirement rather than a
// shortcut: `performance.now()` counts from a per-document origin that resets on reload,
// so an anchor written before a restart would be measured against a clock that has since
// gone back to zero — yielding a delta that is negative or meaningless.
//
// A cold start therefore legitimately has no anchor, and `stampFor` falls back to the
// wall clock with `approx: true`. That is the honest degradation: the review is still
// recorded, still clamped by the server, and marked as estimated.

let current: ClockAnchor | null = null;

export function setAnchor(a: ClockAnchor | null): void {
  current = a;
}

export function getAnchor(): ClockAnchor | null {
  return current;
}
