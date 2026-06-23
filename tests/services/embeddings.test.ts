import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { relatedWords } from "@/services/embeddings";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("relatedWords", () => {
  it("calls related_words and maps rows to camelCase", async () => {
    stub.rpc.mockResolvedValue({
      data: [
        { entry_id: "1467640", writing: "犬", gloss: "dog", distance: 0.12 },
        { entry_id: "1578850", writing: "動物", gloss: "animal", distance: 0.31 },
      ],
      error: null,
    });

    const res = await relatedWords({ entryId: "1467810", limit: 5 });

    expect(stub.rpc).toHaveBeenCalledWith("related_words", {
      p_entry_id: "1467810",
      p_limit: 5,
    });
    expect(res).toEqual([
      { entryId: "1467640", writing: "犬", gloss: "dog", distance: 0.12 },
      { entryId: "1578850", writing: "動物", gloss: "animal", distance: 0.31 },
    ]);
  });

  it("returns an empty array when the entry isn't embedded", async () => {
    stub.rpc.mockResolvedValue({ data: [], error: null });
    expect(await relatedWords({ entryId: "nope" })).toEqual([]);
  });

  it("throws a ServiceError on RPC failure", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(relatedWords({ entryId: "x" })).rejects.toBeTruthy();
  });
});
