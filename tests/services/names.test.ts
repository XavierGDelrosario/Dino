import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { getCuratedNames, mergeCuratedNames, __resetCuratedNames, type CuratedName } from "@/services/names";
import type { AnalyzedToken } from "@/services/language";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  __resetCuratedNames();
});

const tok = (text: string, start: number, extra: Partial<AnalyzedToken> = {}): AnalyzedToken =>
  ({ text, start, end: start + text.length, reading: null, lemma: text, pos: "名詞", ...extra }) as AnalyzedToken;
const NAMES = new Map<string, CuratedName>([
  ["大谷翔平", { reading: "おおたにしょうへい", meaning: "Shohei Ohtani", kind: "person" }],
  ["大谷", { reading: "おおたに", meaning: "Ohtani", kind: "person" }],
]);

describe("mergeCuratedNames", () => {
  it("folds the pieces the tokenizer split a name into back into ONE name token", () => {
    // kuromoji: 大谷 (read オオヤ) + 翔 + 平 — and 平 alone is the word "flat".
    const tokens = [tok("大谷", 0, { reading: "おおや", pos: "人名", nameKind: "person" }), tok("翔", 2), tok("平", 3), tok("が", 4, { pos: "助詞" })];
    const out = mergeCuratedNames(tokens, NAMES);
    expect(out.map((t) => t.text)).toEqual(["大谷翔平", "が"]);
    expect(out[0]).toMatchObject({ start: 0, end: 4, reading: "おおたにしょうへい", nameKind: "person", pos: "人名" });
  });

  it("prefers the LONGEST name, and still corrects the surname on its own", () => {
    const alone = mergeCuratedNames([tok("大谷", 0, { reading: "おおや" }), tok("は", 2, { pos: "助詞" })], NAMES);
    expect(alone[0]).toMatchObject({ text: "大谷", reading: "おおたに", nameKind: "person" });
  });

  it("does not join pieces that were not written together", () => {
    // A gap between the tokens (a space, a line break) → not one name.
    const tokens = [tok("大谷", 0), tok("翔", 3), tok("平", 4)];
    expect(mergeCuratedNames(tokens, NAMES).map((t) => t.text)).toEqual(["大谷", "翔", "平"]);
  });

  it("returns the SAME array when nothing matches", () => {
    const tokens = [tok("猫", 0), tok("が", 1, { pos: "助詞" })];
    expect(mergeCuratedNames(tokens, NAMES)).toBe(tokens);
    expect(mergeCuratedNames(tokens, new Map())).toBe(tokens);
  });
});

describe("getCuratedNames", () => {
  const rows = [{ surface: "大谷翔平", reading: "おおたにしょうへい", meaning: "Shohei Ohtani", kind: "person" }];

  it("reads the pair's names once per session", async () => {
    stub.queueFrom("curated_names", { data: rows, error: null });
    const first = await getCuratedNames("JA", "EN");
    const again = await getCuratedNames("JA", "EN");
    expect(first.get("大谷翔平")?.meaning).toBe("Shohei Ohtani");
    expect(again).toBe(first);
    expect(stub.callsFor("curated_names", "select")).toHaveLength(1);
  });

  it("an un-migrated database or a failed read means no curated names — never a throw", async () => {
    stub.queueFrom("curated_names", { data: null, error: { code: "PGRST205", message: "no table" } });
    expect((await getCuratedNames("JA", "EN")).size).toBe(0);
  });

  it("a failed load is not remembered: the next call asks again", async () => {
    stub.queueFrom("curated_names", { data: null, error: { code: "PGRST205", message: "no table" } });
    await getCuratedNames("JA", "EN");
    stub.queueFrom("curated_names", { data: rows, error: null });
    expect((await getCuratedNames("JA", "EN")).size).toBe(1);
  });
});
