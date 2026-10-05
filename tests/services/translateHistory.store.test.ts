// @vitest-environment jsdom
// The device store behind the translate history: per user, capped, and erasable.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  MAX_HISTORY,
  forgetHistory,
  loadHistory,
  saveHistory,
  type TranslateHistoryEntry,
} from "@/services/translateHistory";

const entry = (text: string): TranslateHistoryEntry => ({ text, source: "JA", target: "EN" }) as TranslateHistoryEntry;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("translate history — device store", () => {
  it("round-trips a user's list", () => {
    saveHistory("u1", [entry("猫"), entry("犬")]);
    expect(loadHistory("u1").map((e) => e.text)).toEqual(["猫", "犬"]);
  });

  it("is per user", () => {
    saveHistory("u1", [entry("猫")]);
    expect(loadHistory("u2")).toEqual([]);
  });

  it("an empty list leaves nothing behind", () => {
    saveHistory("u1", [entry("猫")]);
    saveHistory("u1", []);
    expect(localStorage.length).toBe(0);
  });

  it("forgetHistory erases one user's and leaves another's", () => {
    saveHistory("u1", [entry("猫")]);
    saveHistory("u2", [entry("犬")]);
    forgetHistory("u1");
    expect(loadHistory("u1")).toEqual([]);
    expect(loadHistory("u2").map((e) => e.text)).toEqual(["犬"]);
    forgetHistory(null); // no user: nothing to do, and no throw
  });

  it("ignores anything stored that isn't a history entry, and never returns more than the cap", () => {
    localStorage.setItem("dino.translateHistory.u1", JSON.stringify([entry("ok"), { text: 5 }, null, "x"]));
    expect(loadHistory("u1").map((e) => e.text)).toEqual(["ok"]);
    localStorage.setItem(
      "dino.translateHistory.u1",
      JSON.stringify(Array.from({ length: MAX_HISTORY + 20 }, (_, i) => entry(`w${i}`))),
    );
    expect(loadHistory("u1")).toHaveLength(MAX_HISTORY);
    localStorage.setItem("dino.translateHistory.u1", "not json");
    expect(loadHistory("u1")).toEqual([]);
  });

  it("a FULL store keeps the newer half rather than losing everything", () => {
    const list = Array.from({ length: 10 }, (_, i) => entry(`w${i}`));
    const real = Storage.prototype.setItem;
    let calls = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (++calls === 1) throw new DOMException("full", "QuotaExceededError");
      real.call(this, k, v);
    });
    saveHistory("u1", list);
    expect(loadHistory("u1").map((e) => e.text)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });

  it("never throws when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveHistory("u1", [entry("猫")])).not.toThrow();
    expect(loadHistory("u1")).toEqual([]);
  });
});
