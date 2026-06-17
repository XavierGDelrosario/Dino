import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import {
  getOrCreateAllListId,
  listUserLists,
  createList,
  renameList,
  deleteList,
} from "@/services/lists";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("getOrCreateAllListId", () => {
  it("returns the existing ALL list id", async () => {
    stub.queueFrom("lists", { data: { list_id: "all-1" }, error: null });
    expect(await getOrCreateAllListId("u")).toBe("all-1");
    expect(stub.fromCalls.filter((t) => t === "lists")).toHaveLength(1); // no insert
  });

  it("creates the ALL list when missing (idempotent upsert)", async () => {
    stub.queueFrom(
      "lists",
      { data: null, error: null }, // maybeSingle: not found
      { data: { list_id: "all-2" }, error: null } // upsert ... single
    );
    expect(await getOrCreateAllListId("u")).toBe("all-2");
    expect(stub.fromCalls.filter((t) => t === "lists")).toHaveLength(2);
  });
});

describe("listUserLists", () => {
  it("maps rows to camelCase and sorts ALL first", async () => {
    stub.queueFrom("lists", {
      data: [
        { list_id: "2", list_name: "Verbs" },
        { list_id: "1", list_name: "ALL" },
        { list_id: "3", list_name: "Animals" },
      ],
      error: null,
    });
    const lists = await listUserLists("u");
    expect(lists[0]).toEqual({ listId: "1", listName: "ALL" });
    expect(lists.map((l) => l.listName)).toEqual(["ALL", "Verbs", "Animals"]);
  });

  it("returns [] when the user has no lists", async () => {
    stub.queueFrom("lists", { data: [], error: null });
    expect(await listUserLists("u")).toEqual([]);
  });
});

describe("createList", () => {
  it("creates a non-reserved list", async () => {
    stub.queueFrom("lists", {
      data: { list_id: "x", list_name: "Verbs" },
      error: null,
    });
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
  });
});

describe("renameList", () => {
  it("refuses to rename TO the reserved name (before touching the DB)", async () => {
    await expect(renameList({ listId: "x", listName: "ALL" })).rejects.toThrow(/reserved/i);
    expect(stub.fromCalls).toHaveLength(0);
  });

  it("refuses to rename the ALL list itself", async () => {
    stub.queueFrom("lists", { data: { list_name: "ALL" }, error: null });
    await expect(renameList({ listId: "all-1", listName: "Verbs" })).rejects.toThrow(
      /cannot be renamed/i
    );
  });

  it("renames an editable list", async () => {
    stub.queueFrom(
      "lists",
      { data: { list_name: "Verbs" }, error: null }, // assertEditable
      { data: null, error: null } // update
    );
    await expect(renameList({ listId: "l1", listName: "Nouns" })).resolves.toBeUndefined();
    const update = stub.callsFor("lists", "update")[0];
    expect(update?.args[0]).toEqual({ list_name: "Nouns" });
  });
});

describe("deleteList", () => {
  it("refuses to delete the ALL list", async () => {
    stub.queueFrom("lists", { data: { list_name: "ALL" }, error: null });
    await expect(deleteList("all-1")).rejects.toThrow(/cannot be renamed or deleted/i);
  });

  it("deletes an editable list", async () => {
    stub.queueFrom(
      "lists",
      { data: { list_name: "Verbs" }, error: null }, // assertEditable
      { data: null, error: null } // delete
    );
    await expect(deleteList("l1")).resolves.toBeUndefined();
    expect(stub.callsFor("lists", "delete")).toHaveLength(1);
  });
});
