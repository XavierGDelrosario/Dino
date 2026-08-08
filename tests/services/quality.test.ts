import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { reportQualityIssue, REPORT_MAX_CHARS } from "@/services/quality";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  stub.rpc.mockResolvedValue({ data: null, error: null });
});

describe("reportQualityIssue", () => {
  it("sends the word, the note and the exact sense", async () => {
    await reportQualityIssue({ input: "辛い", description: "wrong reading", wordId: "w-1" });

    expect(stub.rpc).toHaveBeenCalledWith("report_quality_issue", {
      p_input: "辛い",
      p_description: "wrong reading",
      p_word_id: "w-1",
    });
  });

  // The whole point of the flag: the signal is "this word is wrong", which the surface
  // already knows. Requiring prose would lose most reports, so an empty box still files.
  it("files with NO description — the box is optional", async () => {
    await reportQualityIssue({ input: "猫" });

    const args = stub.rpc.mock.calls[0][1] as { p_description?: string };
    expect(args.p_description).toBeUndefined();
  });

  it("treats a whitespace-only note as no note", async () => {
    await reportQualityIssue({ input: "猫", description: "   \n " });

    const args = stub.rpc.mock.calls[0][1] as { p_description?: string };
    expect(args.p_description).toBeUndefined();
  });

  it("NFC-normalizes and trims the reported word (cache-key correctness)", async () => {
    await reportQualityIssue({ input: "  猫  " });

    expect((stub.rpc.mock.calls[0][1] as { p_input: string }).p_input).toBe("猫");
  });

  it("caps the note length rather than letting the column be used as storage", async () => {
    await reportQualityIssue({ input: "猫", description: "x".repeat(REPORT_MAX_CHARS + 50) });

    const args = stub.rpc.mock.calls[0][1] as { p_description: string };
    expect(args.p_description).toHaveLength(REPORT_MAX_CHARS);
  });

  // A caller bug, not a user one — the surface fills `input` from what is on screen.
  it("refuses an empty target without calling the RPC", async () => {
    await expect(reportQualityIssue({ input: "   " })).rejects.toThrow(/Nothing to report/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it("surfaces the RPC's error (e.g. the daily cap) as a ServiceError", async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { message: "report limit reached", code: "54000" },
    });
    await expect(reportQualityIssue({ input: "猫" })).rejects.toThrow(/report limit reached/);
  });
});
