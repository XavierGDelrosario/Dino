import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

// Point the singleton client at a stub whose `functions.invoke` we control.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { fetchLearnWords } from "@/services/learn";

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
