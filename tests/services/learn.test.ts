import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

// Point the singleton client at a stub whose `functions.invoke` we control.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { fetchLearnWords, nextLearnBatch } from "@/services/learn";
import { makeWord } from "@test/fixtures";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("fetchLearnWords", () => {
  it("invokes the edge function in learn mode and returns its cards", async () => {
    const cat = { wordId: "1", input: "猫", translation: "cat" };
    const dog = { wordId: "2", input: "犬", translation: "dog" };
    stub.functions.invoke.mockResolvedValue({
      data: { cards: [[cat], [dog]] },
      error: null,
    });

    const cards = await fetchLearnWords({ band: 1, source: "JA", target: "EN", limit: 10 });

    expect(stub.functions.invoke).toHaveBeenCalledWith("translate", {
      body: {
        learn: { band: 1, limit: 10 },
        sourceLang: "JA",
        targetLang: "EN",
      },
    });
    expect(cards).toEqual([[cat], [dog]]);
  });

  // The edge rejects source === target with a 400 raised BEFORE the learn branch, so
  // supabase-js reported only "Edge Function returned a non-2xx status code" and nothing
  // reached error_log. Reached live: defaults are learning JA + native EN, so an
  // EN-native picking English on the Learn tab collapsed the pair to EN→EN.
  it("refuses a same-language pair without calling the edge at all", async () => {
    await expect(fetchLearnWords({ band: 1, source: "EN", target: "EN" })).rejects.toThrow(
      /must differ/,
    );
    expect(stub.functions.invoke).not.toHaveBeenCalled();
  });

  it("forwards excludeSeen when given (the calibration quiz passes false)", async () => {
    stub.functions.invoke.mockResolvedValue({ data: { cards: [] }, error: null });
    await fetchLearnWords({ band: 2, source: "JA", target: "EN", limit: 8, excludeSeen: false });
    expect(stub.functions.invoke).toHaveBeenCalledWith("translate", {
      body: {
        learn: { band: 2, limit: 8, excludeSeen: false },
        sourceLang: "JA",
        targetLang: "EN",
      },
    });
  });

  it("returns [] when the response carries no cards", async () => {
    stub.functions.invoke.mockResolvedValue({ data: {}, error: null });
    expect(await fetchLearnWords({ band: 3, source: "JA", target: "EN" })).toEqual([]);
  });

  it("throws on a function error", async () => {
    stub.functions.invoke.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(
      fetchLearnWords({ band: 1, source: "JA", target: "EN" }),
    ).rejects.toThrow("boom");
  });

  it("throws on an empty response", async () => {
    stub.functions.invoke.mockResolvedValue({ data: null, error: null });
    await expect(
      fetchLearnWords({ band: 1, source: "JA", target: "EN" }),
    ).rejects.toThrow(/empty response/i);
  });
});

describe("nextLearnBatch (the prefetched next quiz)", () => {
  const card = (input: string) => [makeWord({ wordId: `w-${input}`, input })];

  it("drops every word of the batch being quizzed and keeps at most `size`", () => {
    const current = [card("猫"), card("犬")];
    const fetched = [card("猫"), card("鳥"), card("犬"), card("魚"), card("馬")];
    expect(nextLearnBatch(current, fetched, 2).map((c) => c[0].input)).toEqual(["鳥", "魚"]);
  });

  it("returns fewer (possibly none) when the level is running out", () => {
    expect(nextLearnBatch([card("猫")], [card("猫")])).toEqual([]);
  });

  it("leads each card with the curated primary — N5's すぎ is not a fish (quality report #42)", async () => {
    const w = (wordId: string, input: string, inputReading: string | null) =>
      ({ wordId, input, inputReading, translation: wordId }) as never;
    stub.functions.invoke.mockResolvedValue({
      data: {
        cards: [
          [w("cobia", "すぎ", "須義"), w("past", "過ぎ", "すぎ"), w("cedar", "杉", "すぎ")],
          [w("shitate", "下手", "したて"), w("heta", "下手", "へた")],
          [w("neko", "猫", "ねこ")],
        ],
      },
      error: null,
    });

    const cards = await fetchLearnWords({ band: 1, source: "JA", target: "EN" });
    expect(cards.map((c) => c[0].wordId)).toEqual(["past", "heta", "neko"]);
    expect(cards[0].map((x) => x.wordId)).toEqual(["past", "cobia", "cedar"]); // nothing dropped
  });
});
