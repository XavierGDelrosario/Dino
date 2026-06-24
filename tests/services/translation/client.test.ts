import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

// Point the singleton client at a stub whose `functions.invoke` we control.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { translate, translateBatch } from "@/services/translation/client";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("translate", () => {
  it("invokes the `translate` edge function and returns its data", async () => {
    const result = { translated: true, translation: "cat", word: null };
    stub.functions.invoke.mockResolvedValue({ data: result, error: null });

    const out = await translate({ input: "猫", sourceLang: "JA", targetLang: "EN" });

    expect(stub.functions.invoke).toHaveBeenCalledWith("translate", {
      body: expect.objectContaining({ input: "猫", sourceLang: "JA", targetLang: "EN" }),
    });
    // A per-call idempotency key is attached so retries replay (not re-spend).
    const sent = stub.functions.invoke.mock.calls[0][1].body;
    expect(typeof sent.idempotencyKey).toBe("string");
    expect(sent.idempotencyKey.length).toBeGreaterThan(0);
    expect(out).toBe(result);
  });

  it("surfaces the multi-sense `words` array from the function response", async () => {
    const words = [
      { wordId: "1", input: "高い", translation: "high", sourceLang: "JA", targetLang: "EN", inputReading: "たかい", translationReading: null, isVerified: true },
      { wordId: "2", input: "高い", translation: "expensive", sourceLang: "JA", targetLang: "EN", inputReading: "たかい", translationReading: null, isVerified: true },
    ];
    stub.functions.invoke.mockResolvedValue({
      data: { translated: true, translation: "high", word: words[0], words },
      error: null,
    });

    const out = await translate({ input: "高い", sourceLang: "JA", targetLang: "EN" });
    expect(out.words).toEqual(words);
  });

  it("throws when the function returns an error", async () => {
    stub.functions.invoke.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(
      translate({ input: "猫", sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow("boom");
  });

  it("throws on an empty response", async () => {
    stub.functions.invoke.mockResolvedValue({ data: null, error: null });
    await expect(
      translate({ input: "猫", sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow(/empty response/i);
  });
});

describe("translateBatch", () => {
  it("sends the inputs in one invoke and returns a term→senses Map", async () => {
    const neko = { wordId: "1", input: "猫", translation: "cat" };
    const inu = { wordId: "2", input: "犬", translation: "dog" };
    stub.functions.invoke.mockResolvedValue({
      data: {
        results: [
          { input: "猫", translated: true, words: [neko] },
          { input: "犬", translated: true, words: [inu] },
          { input: "鳥", translated: false, words: [] }, // no result → empty
        ],
      },
      error: null,
    });

    const map = await translateBatch({ inputs: ["猫", "犬", "鳥"], sourceLang: "JA", targetLang: "EN" });

    expect(stub.functions.invoke).toHaveBeenCalledWith("translate", {
      body: expect.objectContaining({ inputs: ["猫", "犬", "鳥"], sourceLang: "JA", targetLang: "EN" }),
    });
    expect(map.get("猫")).toEqual([neko]);
    expect(map.get("犬")).toEqual([inu]);
    expect(map.get("鳥")).toEqual([]); // present but empty
  });

  it("short-circuits with no invoke for an empty input list", async () => {
    const map = await translateBatch({ inputs: [], sourceLang: "JA", targetLang: "EN" });
    expect(map.size).toBe(0);
    expect(stub.functions.invoke).not.toHaveBeenCalled();
  });

  it("throws on a function error", async () => {
    stub.functions.invoke.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(
      translateBatch({ inputs: ["猫"], sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow("boom");
  });
});
