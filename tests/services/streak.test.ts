// The streak rule, pinned: either kind of work keeps it, today still counts while it is
// unfinished, and the longest run survives a broken current one.
import { describe, it, expect } from "vitest";
import { computeStreaks, previousDay, todayProgress, type StudyDay } from "@/services/streak";

const d = (day: string, added = 0, reviews = 0): StudyDay => ({ day, added, reviewed: reviews ? 1 : 0, reviews });

describe("computeStreaks", () => {
  it("counts consecutive studied days ending today", () => {
    const s = computeStreaks([d("2026-10-04", 1), d("2026-10-05", 0, 2), d("2026-10-06", 3)], "2026-10-06");
    expect(s).toEqual({ current: 3, longest: 3, studiedToday: true });
  });

  it("keeps the streak alive when today has not been studied yet", () => {
    const s = computeStreaks([d("2026-10-04", 1), d("2026-10-05", 1)], "2026-10-06");
    expect(s.current).toBe(2);
    expect(s.studiedToday).toBe(false);
  });

  it("is zero once yesterday was missed too", () => {
    const s = computeStreaks([d("2026-10-03", 1), d("2026-10-04", 1)], "2026-10-06");
    expect(s.current).toBe(0);
    expect(s.longest).toBe(2);
  });

  it("ignores days with rows but no activity", () => {
    const s = computeStreaks([d("2026-10-05", 0, 0), d("2026-10-06", 1)], "2026-10-06");
    expect(s.current).toBe(1);
  });

  it("finds the longest run anywhere in the past", () => {
    const days = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-03-10", "2026-10-06"].map((k) => d(k, 1));
    const s = computeStreaks(days, "2026-10-06");
    expect(s).toEqual({ current: 1, longest: 4, studiedToday: true });
  });

  it("crosses month and year boundaries", () => {
    const s = computeStreaks([d("2025-12-31", 1), d("2026-01-01", 1)], "2026-01-01");
    expect(s.current).toBe(2);
  });

  it("is empty for a brand-new user", () => {
    expect(computeStreaks([], "2026-10-06")).toEqual({ current: 0, longest: 0, studiedToday: false });
  });
});

describe("previousDay", () => {
  it("steps back across a month boundary", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });
});

describe("todayProgress", () => {
  it("reads today's row, zero otherwise", () => {
    expect(todayProgress([d("2026-10-06", 4, 9)], "2026-10-06")).toEqual({ added: 4, reviews: 9 });
    expect(todayProgress([d("2026-10-05", 4, 9)], "2026-10-06")).toEqual({ added: 0, reviews: 0 });
  });
});
