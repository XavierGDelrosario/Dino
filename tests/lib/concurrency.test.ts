import { describe, it, expect } from "vitest";
import { mapLimit } from "@/lib/concurrency";

describe("mapLimit", () => {
  it("returns results in input order regardless of completion order", async () => {
    // Later items resolve sooner, so order can only be right if preserved by index.
    const delays = [30, 10, 20, 0];
    const out = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // and it actually saturates the limit
  });

  it("returns [] for empty input without calling fn", async () => {
    let called = false;
    const out = await mapLimit([], 4, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("clamps a limit below 1 to a single worker (still completes)", async () => {
    const out = await mapLimit([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it("handles a limit larger than the number of items", async () => {
    const out = await mapLimit([1, 2], 100, async (n) => n + 1);
    expect(out).toEqual([2, 3]);
  });

  it("rejects if any task rejects", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });
});
