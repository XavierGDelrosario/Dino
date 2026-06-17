import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { listUserLists, createList, renameList, deleteList } from "@/services/lists";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("listUserLists", () => {
  it("maps rows to camelCase (sub-lists only — ALL is virtual)", async () => {
    stub.queueFrom("lists", {
      data: [
        { list_id: "1", list_name: "Animals" },
        { list_id: "2", list_name: "Verbs" },
      ],
      error: null,
    });
    expect(await listUserLists("u")).toEqual([
      { listId: "1", listName: "Animals" },
      { listId: "2", listName: "Verbs" },
    ]);
  });

  it("returns [] when the user has no sub-lists", async () => {
    stub.queueFrom("lists", { data: [], error: null });
    expect(await listUserLists("u")).toEqual([]);
  });
});

describe("createList", () => {
  it("creates a non-reserved list", async () => {
    stub.queueFrom("lists", { data: { list_id: "x", list_name: "Verbs" }, error: null });
    expect(await createList({ userId: "u", listName: "  Verbs  " })).toEqual({
      listId: "x",
      listName: "Verbs",
    });
  });

  it("rejects an empty name", async () => {
    await expect(createList({ userId: "u", listName: "   " })).rejects.toThrow(/required/i);
  });

  it.each(["ALL", "all", "All"])("rejects the reserved name %s", async (name) => {
    await expect(createList({ userId: "u", listName: name })).rejects.toThrow(/reserved/i);
    expect(stub.fromCalls).toEqual([]); // guarded before any DB write
  });
});

describe("renameList", () => {
  it("refuses to rename TO the reserved name (before touching the DB)", async () => {
    await expect(renameList({ listId: "x", listName: "ALL" })).rejects.toThrow(/reserved/i);
    expect(stub.fromCalls).toEqual([]);
  });

  it("renames a sub-list in place (no ALL-protection read)", async () => {
    stub.queueFrom("lists", { data: null, error: null });
    await expect(renameList({ listId: "l1", listName: "Nouns" })).resolves.toBeUndefined();
    expect(stub.callsFor("lists", "update")[0]?.args[0]).toEqual({ list_name: "Nouns" });
    expect(stub.fromCalls).toEqual(["lists"]); // single write, no pre-read
  });
});

describe("deleteList", () => {
  it("deletes a sub-list (tags cascade; user_words survive)", async () => {
    stub.queueFrom("lists", { data: null, error: null });
    await expect(deleteList("l1")).resolves.toBeUndefined();
    expect(stub.callsFor("lists", "delete")).toHaveLength(1);
    expect(stub.fromCalls).toEqual(["lists"]);
  });
});
