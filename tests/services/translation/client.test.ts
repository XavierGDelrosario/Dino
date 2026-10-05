import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

// Point the singleton client at a stub whose `functions.invoke` we control.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

// The on-device translator exists only in the iOS app; everywhere else it reports
// "can't", and these tests switch it on case by case.
const device = vi.hoisted(() => ({ can: vi.fn(() => false), translate: vi.fn() }));
vi.mock("@/services/translation/onDevice", () => ({
  canTranslateOnDevice: device.can,
  translateOnDevice: device.translate,
}));

import { translate, translateBatch, translateSegments } from "@/services/translation/client";

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

// A quota refusal is a 429 whose body carries a `code`; the user should read what
// happened and what still works, not "Edge Function returned a non-2xx status code".
describe("translate — quota refusals", () => {
  const refused = (body: unknown) => {
    const err = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      name: "FunctionsHttpError",
      context: new Response(JSON.stringify(body), { status: 429 }),
    });
    stub.functions.invoke.mockResolvedValue({ data: null, error: err });
  };
  const run = () => translate({ input: "猫が好き", sourceLang: "JA", targetLang: "EN", persist: false });

  it("tells a guest to create an account", async () => {
    refused({ error: "Monthly translation quota reached", code: "guest_quota", used: 30000, quota: 30000 });
    await expect(run()).rejects.toThrow(/Create a free account/);
  });

  it("tells an account holder the limit resets next month", async () => {
    refused({ error: "Monthly translation quota reached", code: "user_quota" });
    await expect(run()).rejects.toThrow(/reset next month/);
  });

  it("the global cap reads as busy, and nothing is retried", async () => {
    refused({ error: "Service translation quota reached", code: "global_quota" });
    await expect(run()).rejects.toThrow(/busy right now/);
    expect(stub.functions.invoke).toHaveBeenCalledTimes(1);
  });

  it("a 429 without a known code keeps the generic error", async () => {
    refused({ error: "something else" });
    await expect(run()).rejects.toThrow("non-2xx");
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

describe("translateSegments — where the gloss comes from", () => {
  const PARAMS = { segments: ["猫が好き。", "犬も好き。"], sourceLang: "JA" as const, targetLang: "EN" as const };
  const cloud = () =>
    stub.functions.invoke.mockResolvedValue({ data: { glosses: ["cloud 1", "cloud 2"] }, error: null });
  const refused = () =>
    stub.functions.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("non-2xx"), {
        name: "FunctionsHttpError",
        context: new Response(JSON.stringify({ code: "user_quota" }), { status: 429 }),
      }),
    });
  const signedInAs = (guest: boolean) =>
    stub.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u", is_anonymous: guest } } }, error: null });

  beforeEach(() => {
    device.can.mockReset().mockReturnValue(false);
    device.translate.mockReset().mockResolvedValue(["device 1", "device 2"]);
    signedInAs(false);
  });

  it("on the web it is the cloud, and the device is never asked", async () => {
    cloud();
    signedInAs(true);
    expect(await translateSegments(PARAMS)).toEqual(["cloud 1", "cloud 2"]);
    expect(device.translate).not.toHaveBeenCalled();
  });

  it("a GUEST in the app is glossed on the device, spending nothing", async () => {
    device.can.mockReturnValue(true);
    signedInAs(true);
    expect(await translateSegments(PARAMS)).toEqual(["device 1", "device 2"]);
    expect(stub.functions.invoke).not.toHaveBeenCalled();
  });

  it("a guest whose models aren't on the phone yet still gets the cloud gloss", async () => {
    device.can.mockReturnValue(true);
    device.translate.mockRejectedValue(new Error("language models are still downloading"));
    signedInAs(true);
    cloud();
    expect(await translateSegments(PARAMS)).toEqual(["cloud 1", "cloud 2"]);
  });

  it("a MEMBER in the app gets the cloud translation while the quota allows", async () => {
    device.can.mockReturnValue(true);
    cloud();
    expect(await translateSegments(PARAMS)).toEqual(["cloud 1", "cloud 2"]);
    expect(device.translate).not.toHaveBeenCalled();
  });

  it("a member OVER QUOTA in the app falls back to the device instead of an error", async () => {
    device.can.mockReturnValue(true);
    refused();
    expect(await translateSegments(PARAMS)).toEqual(["device 1", "device 2"]);
  });

  it("over quota with no usable device translator, the refusal is what the user sees", async () => {
    device.can.mockReturnValue(true);
    device.translate.mockRejectedValue(new Error("language models are still downloading"));
    refused();
    await expect(translateSegments(PARAMS)).rejects.toThrow(/reset next month/);
  });

  it("over quota on the web, the refusal stands", async () => {
    refused();
    await expect(translateSegments(PARAMS)).rejects.toThrow(/reset next month/);
    expect(device.translate).not.toHaveBeenCalled();
  });

  it("any OTHER cloud failure is not papered over with a rougher translation", async () => {
    device.can.mockReturnValue(true);
    stub.functions.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("bad request"), {
        name: "FunctionsHttpError",
        context: new Response("{}", { status: 400 }),
      }),
    });
    await expect(translateSegments(PARAMS)).rejects.toThrow();
    expect(device.translate).not.toHaveBeenCalled();
  });
});
