// The daily-word widget feed.
//
// What's pinned: the schedule's shape (the two widgets never share a word on a day,
// saved words beat the fallback), and the sync's manners — inert off-native, once per
// local day, and never settling the day on a half-finished draw.
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, because dailyWord.ts calls registerPlugin at MODULE scope.
const { setPayload, isNativePlatform, isPluginAvailable, fetchLearnWords, peekReviewQueue, getUserProfile, getBand } =
  vi.hoisted(() => ({
    setPayload: vi.fn(),
    isNativePlatform: vi.fn(),
    isPluginAvailable: vi.fn(),
    fetchLearnWords: vi.fn(),
    peekReviewQueue: vi.fn(),
    getUserProfile: vi.fn(),
    getBand: vi.fn(),
  }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
    isPluginAvailable: (n: string) => isPluginAvailable(n),
  },
  registerPlugin: () => ({ setPayload }),
}));
vi.mock("@/services/learn", () => ({ fetchLearnWords }));
vi.mock("@/services/review", () => ({ peekReviewQueue }));
vi.mock("@/services/session", () => ({ getUserProfile }));
vi.mock("@/services/calibration", () => ({ getUserProficiencyBand: getBand }));

import {
  WIDGET_DAYS,
  WIDGET_PAYLOAD_VERSION,
  buildDailyWordPayload,
  localDay,
  syncDailyWordWidget,
  type DailyWordPayload,
} from "@/services/widget/dailyWord";
import type { ReviewQueueItem } from "@/services/review";
import { makeWord } from "@test/fixtures";

const card = (i: number) => [makeWord({ wordId: `w${i}`, input: `語${i}`, translation: `word ${i}` })];
const cards = (n: number) => Array.from({ length: n }, (_, i) => card(i));
const saved = (i: number, confidence = 2) =>
  ({
    userWordId: `u${i}`,
    input: `覚${i}`,
    inputReading: "おぼ",
    translation: `saved ${i}`,
    sourceLang: "JA",
    targetLang: "EN",
    proficiencyBand: 2,
    confidenceRating: confidence,
  }) as ReviewQueueItem;

describe("buildDailyWordPayload", () => {
  it("resolves a card to its primary sense, reading and level label", () => {
    const p = buildDailyWordPayload({
      day: "2026-10-06",
      cards: [
        [
          makeWord({ input: "猫", inputReading: "ねこ", translation: "cat", proficiencyBand: 1 }),
          makeWord({ input: "猫", translation: "bottom (slang)" }),
        ],
      ],
      review: [],
    });
    expect(p.version).toBe(WIDGET_PAYLOAD_VERSION);
    expect(p.day).toBe("2026-10-06");
    expect(p.newWords).toEqual([
      { headword: "猫", reading: "ねこ", meaning: "cat", level: "N5", lang: "JA", confidence: null },
    ]);
  });

  it("gives the review widget the saved words, with their confidence", () => {
    const p = buildDailyWordPayload({ day: "d", cards: cards(WIDGET_DAYS * 2), review: [saved(0, 3), saved(1, 1)] });
    expect(p.reviewWords.map((w) => w.headword)).toEqual(["覚0", "覚1"]);
    expect(p.reviewWords[0]).toMatchObject({ meaning: "saved 0", level: "N4", confidence: 3 });
    expect(p.newWords).toHaveLength(WIDGET_DAYS);
  });

  it("falls back to new words the New widget is NOT showing when nothing is saved", () => {
    const p = buildDailyWordPayload({ day: "d", cards: cards(WIDGET_DAYS * 2), review: [] });
    const shown = new Set(p.newWords.map((w) => w.headword));
    expect(p.reviewWords).toHaveLength(WIDGET_DAYS);
    expect(p.reviewWords.some((w) => shown.has(w.headword))).toBe(false);
  });

  it("reuses the new words when the draw was too short to split", () => {
    const p = buildDailyWordPayload({ day: "d", cards: cards(3), review: [] });
    expect(p.reviewWords).toEqual(p.newWords);
  });

  it("skips an empty card", () => {
    expect(buildDailyWordPayload({ day: "d", cards: [[], card(1)], review: [] }).newWords).toHaveLength(1);
  });
});

describe("localDay", () => {
  it("is the LOCAL calendar day, zero-padded", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("syncDailyWordWidget", () => {
  const written = (): DailyWordPayload => JSON.parse(setPayload.mock.calls[setPayload.mock.calls.length - 1][0].json);

  beforeEach(() => {
    vi.clearAllMocks();
    // The suite runs in Node: a Map-backed stand-in for the WebView's localStorage.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    isNativePlatform.mockReturnValue(true);
    isPluginAvailable.mockReturnValue(true);
    getUserProfile.mockResolvedValue({ learningLanguage: "JA", nativeLanguage: "EN" });
    getBand.mockResolvedValue(3);
    fetchLearnWords.mockResolvedValue(cards(WIDGET_DAYS * 2));
    peekReviewQueue.mockResolvedValue([saved(0)]);
    setPayload.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("does nothing off-native", async () => {
    isNativePlatform.mockReturnValue(false);
    expect(await syncDailyWordWidget("u1")).toBe(false);
    expect(getUserProfile).not.toHaveBeenCalled();
    expect(setPayload).not.toHaveBeenCalled();
  });

  it("draws at the user's band and pair and writes one payload", async () => {
    expect(await syncDailyWordWidget("u1")).toBe(true);
    expect(fetchLearnWords).toHaveBeenCalledWith({ band: 3, source: "JA", target: "EN", limit: WIDGET_DAYS * 2 });
    expect(peekReviewQueue).toHaveBeenCalledWith({ userId: "u1", limit: WIDGET_DAYS });
    expect(setPayload).toHaveBeenCalledTimes(1);
    expect(written().day).toBe(localDay());
    expect(written().reviewWords[0].headword).toBe("覚0");
  });

  it("starts an uncalibrated user at the easiest band", async () => {
    getBand.mockResolvedValue(null);
    await syncDailyWordWidget("u1");
    expect(fetchLearnWords).toHaveBeenCalledWith(expect.objectContaining({ band: 1 }));
  });

  it("syncs once a day — today's word must not change under the user", async () => {
    await syncDailyWordWidget("u1");
    expect(await syncDailyWordWidget("u1")).toBe(false);
    expect(setPayload).toHaveBeenCalledTimes(1);
  });

  it("re-syncs for another user, a new band, or when forced", async () => {
    await syncDailyWordWidget("u1");
    await syncDailyWordWidget("u2");
    getBand.mockResolvedValue(4);
    await syncDailyWordWidget("u2");
    await syncDailyWordWidget("u2", { force: true });
    expect(setPayload).toHaveBeenCalledTimes(4);
  });

  it("writes what it has when one draw fails, but tries again later", async () => {
    fetchLearnWords.mockRejectedValueOnce(new Error("edge down"));
    expect(await syncDailyWordWidget("u1")).toBe(true);
    expect(written().newWords).toEqual([]);
    expect(written().reviewWords).toHaveLength(1);

    expect(await syncDailyWordWidget("u1")).toBe(true); // not settled → retried
    expect(written().newWords).toHaveLength(WIDGET_DAYS);
  });

  it("keeps the existing schedule when everything fails", async () => {
    fetchLearnWords.mockRejectedValue(new Error("offline"));
    peekReviewQueue.mockRejectedValue(new Error("offline"));
    expect(await syncDailyWordWidget("u1")).toBe(false);
    expect(setPayload).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    getUserProfile.mockRejectedValue(new Error("boom"));
    expect(await syncDailyWordWidget("u1")).toBe(false);
  });
});
