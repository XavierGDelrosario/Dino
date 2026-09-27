import { describe, it, expect } from "vitest";
import {
  activitySeries,
  bandRows,
  bucketStart,
  bucketStarts,
  confidenceLines,
  dayCounts,
  parseHistory,
  type ConfidenceSnapshot,
  type HistoryDay,
} from "@/services/history";
import { dayKey } from "@/services/words/filters";

const day = (d: string, added = 0, reviewed = 0): HistoryDay => ({ day: d, added, reviewed, reviews: reviewed });
// Wed 2026-09-30, local.
const TODAY = new Date(2026, 8, 30);

describe("bucketStart", () => {
  it("weeks start on Monday, months on the 1st", () => {
    expect(dayKey(bucketStart(TODAY, "week"))).toBe("2026-09-28");
    expect(dayKey(bucketStart(new Date(2026, 8, 27), "week"))).toBe("2026-09-21"); // a Sunday
    expect(dayKey(bucketStart(TODAY, "month"))).toBe("2026-09-01");
    expect(dayKey(bucketStart(TODAY, "day"))).toBe("2026-09-30");
  });
});

describe("bucketStarts", () => {
  it("ends with the bucket containing today, oldest first", () => {
    const d = bucketStarts("1m", TODAY).map(dayKey);
    expect(d).toHaveLength(30);
    expect(d[29]).toBe("2026-09-30");
    expect(d[0]).toBe("2026-09-01");
    const m = bucketStarts("1y", TODAY).map(dayKey);
    expect(m[0]).toBe("2025-10-01");
    expect(m[11]).toBe("2026-09-01");
  });
});

describe("activitySeries", () => {
  const days = [
    day("2025-12-15", 100), // before every range: counts toward the total only
    day("2026-09-28", 3, 10),
    day("2026-09-29", 2, 4),
    day("2026-09-30", 1, 0),
  ];

  it("sums added / reviewed per bucket, zero-filled", () => {
    const added = activitySeries(days, "added", "1m", TODAY);
    expect(added.slice(-1)[0]).toEqual({ key: "2026-09-30", value: 1 });
    expect(added.slice(-3)[0]).toEqual({ key: "2026-09-28", value: 3 });
    expect(added[0].value).toBe(0);
    const weekly = activitySeries(days, "reviewed", "3m", TODAY);
    expect(weekly.slice(-1)[0]).toEqual({ key: "2026-09-28", value: 14 });
  });

  it("total is the running vocabulary at the END of each bucket, including before the range", () => {
    const total = activitySeries(days, "total", "1m", TODAY);
    expect(total[0].value).toBe(100);
    expect(total.slice(-3)[0]!.value).toBe(103);
    expect(total.slice(-1)[0]!.value).toBe(106);
    const monthly = activitySeries(days, "total", "1y", TODAY);
    expect(monthly.slice(-1)[0]!.value).toBe(106);
    expect(monthly.slice(-4)[0]!.value).toBe(100); // Jun 2026: only the December words
  });
});

describe("confidenceLines", () => {
  const snap = (d: string, avg: number, bandConf: (number | null)[], bandN: number[]): ConfidenceSnapshot => ({
    day: d, wordCount: 10, avgConf: avg, mainLang: "JA", bandN, bandConf,
  });
  const snaps = [
    snap("2026-09-28", 2, [1, 3, null], [4, 6, 0]),
    snap("2026-09-30", 3, [2, 4, null], [4, 6, 0]),
  ];

  it("averages within a bucket and leaves idle buckets as gaps", () => {
    const daily = confidenceLines(snaps, "1m", TODAY, "JA", "Unranked");
    expect(daily.overall.slice(-1)[0]!.value).toBe(3);
    expect(daily.overall.slice(-2)[0]!.value).toBeNull(); // 09-29: no snapshot
    const weekly = confidenceLines(snaps, "3m", TODAY, "JA", "Unranked");
    expect(weekly.overall.slice(-1)[0]!.value).toBe(2.5);
  });

  it("draws one line per level present (empty slots skipped), unranked last, JLPT labels", () => {
    const { bands } = confidenceLines(snaps, "1m", TODAY, "JA", "Unranked");
    expect(bands.map((b) => b.label)).toEqual(["N5", "Unranked"]);
    expect(bands[0].points.slice(-1)[0]!.value).toBe(4);
  });
});

describe("bandRows", () => {
  it("orders easy → hard with unranked last, labelled by the language's framework", () => {
    const rows = bandRows(
      [
        { band: -1, n: 5, avgConf: 1 },
        { band: 3, n: 2, avgConf: 2 },
        { band: 1, n: 9, avgConf: 4 },
      ],
      "JA",
      "Unranked",
    );
    expect(rows.map((r) => r.label)).toEqual(["N5", "N3", "Unranked"]);
  });
});

describe("dayCounts", () => {
  it("keeps only days with a non-zero count for the metric", () => {
    const m = dayCounts([day("2026-09-28", 3, 0), day("2026-09-29", 0, 5)], "added");
    expect([...m.entries()]).toEqual([["2026-09-28", 3]]);
  });
});

describe("parseHistory", () => {
  it("maps the RPC JSON and tolerates missing parts", () => {
    const h = parseHistory({
      main_lang: "JA",
      days: [{ day: "2026-09-30", added: 2, reviewed: "3", reviews: 4 }],
      bands: [{ band: 1, n: 5, avg_conf: 2.5 }],
      confidence: [{ day: "2026-09-29", word_count: 5, avg_conf: null, main_lang: "JA", band_n: [1, 4], band_conf: [null, 3] }],
    });
    expect(h.days[0]).toEqual({ day: "2026-09-30", added: 2, reviewed: 3, reviews: 4 });
    expect(h.bands[0].avgConf).toBe(2.5);
    expect(h.confidence[0].avgConf).toBeNull();
    expect(h.confidence[0].bandConf).toEqual([null, 3]);
    expect(parseHistory(null)).toEqual({ mainLang: null, days: [], bands: [], confidence: [] });
  });
});
