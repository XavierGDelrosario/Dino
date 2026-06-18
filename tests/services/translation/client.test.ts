import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

// Point the singleton client at a stub whose `functions.invoke` we control.
const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { translate } from "@/services/translation/client";

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
      body: { input: "猫", sourceLang: "JA", targetLang: "EN" },
    });
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
