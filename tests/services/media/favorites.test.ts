import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { listFavorites, addFavorite, removeFavorite } from "@/services/media/favorites";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

const row = {
  favorite_id: "f1",
  title: "台風が九州に接近",
  summary: "気象庁によると…",
  url: "https://ja.wikinews.org/wiki/%E5%8F%B0%E9%A2%A8",
  site: "wikinews",
  lang: "JA",
  created_at: "2026-08-01T00:00:00Z",
};

describe("listFavorites", () => {
  it("maps rows to camelCase", async () => {
    stub.queueFrom("media_favorites", { data: [row], error: null });
    expect(await listFavorites("u")).toEqual([
      {
        favoriteId: "f1",
        title: "台風が九州に接近",
        summary: "気象庁によると…",
        url: row.url,
        site: "wikinews",
        lang: "JA",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("renders a null summary as an empty string (no 'null' in the UI)", async () => {
    stub.queueFrom("media_favorites", { data: [{ ...row, summary: null }], error: null });
    expect((await listFavorites("u"))[0].summary).toBe("");
  });

  it("returns [] when nothing is starred", async () => {
    stub.queueFrom("media_favorites", { data: [], error: null });
    expect(await listFavorites("u")).toEqual([]);
  });
});

describe("addFavorite", () => {
  const headline = { title: "  台風が九州に接近  ", summary: " 気象庁によると… ", url: row.url };

  it("upserts on (user_id, url) so re-starring can't duplicate", async () => {
    stub.queueFrom("media_favorites", { data: row, error: null });
    await addFavorite({ userId: "u", headline });
    const upsert = stub.calls.find((c) => c.method === "upsert");
    expect(upsert?.args[1]).toMatchObject({ onConflict: "user_id,url" });
  });

  it("NFC-trims the title/summary and defaults the re-fetch coordinates", async () => {
    stub.queueFrom("media_favorites", { data: row, error: null });
    await addFavorite({ userId: "u", headline });
    const upsert = stub.calls.find((c) => c.method === "upsert");
    expect(upsert?.args[0]).toEqual({
      user_id: "u",
      title: "台風が九州に接近",
      summary: "気象庁によると…",
      url: row.url,
      site: "wikinews",
      lang: "JA",
    });
  });

  it("stores a blank summary as NULL, not an empty string", async () => {
    stub.queueFrom("media_favorites", { data: { ...row, summary: null }, error: null });
    await addFavorite({ userId: "u", headline: { ...headline, summary: "   " } });
    const upsert = stub.calls.find((c) => c.method === "upsert");
    expect((upsert?.args[0] as { summary: unknown }).summary).toBeNull();
  });

  it("rejects a headline with no title or no url before touching the DB", async () => {
    await expect(
      addFavorite({ userId: "u", headline: { ...headline, title: "  " } }),
    ).rejects.toThrow(/required/i);
    await expect(
      addFavorite({ userId: "u", headline: { ...headline, url: "" } }),
    ).rejects.toThrow(/required/i);
    expect(stub.fromCalls).toEqual([]);
  });

  it("surfaces the per-user cap (trigger raises 23505) as a conflict", async () => {
    stub.queueFrom("media_favorites", {
      data: null,
      error: { code: "23505", message: "favourite limit reached (4000 articles)" },
    });
    await expect(addFavorite({ userId: "u", headline })).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

describe("removeFavorite", () => {
  it("deletes the caller's row for that url", async () => {
    stub.queueFrom("media_favorites", { data: null, error: null });
    await removeFavorite({ userId: "u", url: ` ${row.url} ` });
    const eqs = stub.calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toEqual([
      ["user_id", "u"],
      ["url", row.url],
    ]);
  });

  it("throws a domain error when the delete fails", async () => {
    stub.queueFrom("media_favorites", { data: null, error: { code: "42501", message: "denied" } });
    await expect(removeFavorite({ userId: "u", url: row.url })).rejects.toMatchObject({
      kind: "permission",
    });
  });
});
