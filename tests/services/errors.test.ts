import { describe, it, expect } from "vitest";
import { ServiceError, toServiceError, unwrap } from "@/services/errors";

describe("toServiceError", () => {
  it("maps SQLSTATEs to domain kinds, preserving message + code", () => {
    const cases: Array<[string, string]> = [
      ["23505", "conflict"],
      ["23503", "validation"],
      ["23502", "validation"],
      ["23514", "validation"],
      ["42501", "permission"],
      ["PGRST116", "not_found"],
    ];
    for (const [code, kind] of cases) {
      const e = toServiceError({ message: "boom", code });
      expect(e).toBeInstanceOf(ServiceError);
      expect(e.kind).toBe(kind);
      expect(e.code).toBe(code);
      expect(e.message).toBe("boom"); // original message preserved
    }
  });

  it("an unmapped code is 'unknown' but still keeps message + code", () => {
    const e = toServiceError({ message: "weird", code: "99999" });
    expect(e.kind).toBe("unknown");
    expect(e.code).toBe("99999");
  });

  it("uses the fallback message only when the error carries none", () => {
    const e = toServiceError(null, "Failed to create list");
    expect(e.kind).toBe("unknown");
    expect(e.code).toBeUndefined();
    expect(e.message).toBe("Failed to create list");
  });

  it("is a pass-through for an existing ServiceError", () => {
    const original = new ServiceError("nope", "permission", { code: "42501" });
    expect(toServiceError(original)).toBe(original);
  });
});

describe("unwrap", () => {
  it("returns data when there is no error", () => {
    expect(unwrap({ data: 42, error: null })).toBe(42);
  });

  it("throws a mapped ServiceError on error", () => {
    expect(() => unwrap({ data: null, error: { message: "dup", code: "23505" } }))
      .toThrowError(expect.objectContaining({ kind: "conflict", code: "23505" }));
  });

  it("throws not_found when a required row is missing", () => {
    try {
      unwrap({ data: null, error: null }, "List not found");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).kind).toBe("not_found");
      expect((e as ServiceError).message).toBe("List not found");
    }
  });

  it("returns null data when no row is required", () => {
    expect(unwrap({ data: null, error: null })).toBeNull();
  });
});
