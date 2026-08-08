// The property these tests exist for: an offline review's timestamp must not move when
// the DEVICE CLOCK does. That is the whole reason clock.ts anchors to a server instant
// and measures forward monotonically instead of reading Date.now().
import { describe, it, expect } from "vitest";
import { anchorAt, reviewedAtFrom, stampFor } from "@/services/offline/clock";

/** A controllable monotonic clock — advances only when the test says so. */
function fakeMono(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const SERVER = Date.parse("2026-08-08T10:00:00.000Z");

describe("anchorAt", () => {
  it("pairs the SERVER instant with the monotonic reading at that moment", () => {
    const mono = fakeMono(500);
    expect(anchorAt(SERVER, mono.now)).toEqual({ serverNow: SERVER, mono: 500 });
  });
});

describe("reviewedAtFrom", () => {
  it("advances by the monotonic delta, in server time", () => {
    const mono = fakeMono();
    const anchor = anchorAt(SERVER, mono.now);
    mono.advance(90_000); // 90s of real time
    expect(reviewedAtFrom(anchor, mono.now)).toBe(SERVER + 90_000);
  });

  it("IGNORES the wall clock entirely", () => {
    // The point of the design: nothing here reads Date.now(), so a system-clock change
    // — however wild — cannot influence the result.
    const mono = fakeMono();
    const anchor = anchorAt(SERVER, mono.now);
    mono.advance(5_000);

    const real = Date.now;
    try {
      Date.now = () => Date.parse("1999-01-01T00:00:00.000Z"); // user sets clock to 1999
      expect(reviewedAtFrom(anchor, mono.now)).toBe(SERVER + 5_000);
      Date.now = () => Date.parse("2099-01-01T00:00:00.000Z"); // ...and to 2099
      expect(reviewedAtFrom(anchor, mono.now)).toBe(SERVER + 5_000);
    } finally {
      Date.now = real;
    }
  });

  it("never returns an instant BEFORE the anchor", () => {
    // performance.now() cannot go backwards, but the Date.now() fallback for runtimes
    // without it can. A review that predates the deck it came from is nonsense.
    const mono = fakeMono(10_000);
    const anchor = anchorAt(SERVER, mono.now);
    mono.advance(-8_000);
    expect(reviewedAtFrom(anchor, mono.now)).toBe(SERVER);
  });
});

describe("stampFor", () => {
  it("is exact when anchored", () => {
    const mono = fakeMono();
    const anchor = anchorAt(SERVER, mono.now);
    mono.advance(60_000);
    expect(stampFor(anchor, mono.now)).toEqual({
      reviewedAt: new Date(SERVER + 60_000).toISOString(),
      approx: false,
    });
  });

  it("falls back to the wall clock and FLAGS it when there is no anchor", () => {
    // The cold-start case: the app was killed and relaunched offline, so the in-memory
    // anchor is gone. The review is still recorded — marked approximate, and the server
    // clamps it either way.
    const wall = Date.parse("2026-08-08T12:34:56.000Z");
    expect(stampFor(null, fakeMono().now, () => wall)).toEqual({
      reviewedAt: new Date(wall).toISOString(),
      approx: true,
    });
  });
});
