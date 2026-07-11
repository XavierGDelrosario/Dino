import { describe, it, expect } from "vitest";
import { errorMessage } from "@/lib/errorMessage";
import { ServiceError, toServiceError } from "@/services/errors";

describe("errorMessage", () => {
  it("renders friendly copy for a DB-coded ServiceError (hides raw SQLSTATE text)", () => {
    // A PostgREST unique-violation, wrapped — its raw message is DB internals.
    const dbErr = toServiceError({
      message: 'duplicate key value violates unique constraint "uq_user_words_custom"',
      code: "23505",
    });
    expect(dbErr.kind).toBe("conflict");
    const shown = errorMessage(dbErr);
    expect(shown).toBe("That already exists.");
    expect(shown).not.toContain("constraint");
    // Raw message is preserved on the object for telemetry.
    expect(dbErr.message).toContain("uq_user_words_custom");
  });

  it("renders friendly copy for a permission (RLS) ServiceError", () => {
    const rls = toServiceError({ message: "permission denied for table words", code: "42501" });
    expect(errorMessage(rls)).toBe("You don't have permission to do that.");
  });

  it("keeps the message of an app-authored ServiceError (no provider code)", () => {
    const appErr = new ServiceError("List name is required", "validation");
    expect(errorMessage(appErr)).toBe("List name is required");
  });

  it("keeps a plain Error's message (e.g. an Auth error)", () => {
    expect(errorMessage(new Error("Invalid login credentials"))).toBe("Invalid login credentials");
  });

  it("reads .message off a bare provider-shaped object", () => {
    expect(errorMessage({ message: "boom" })).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(errorMessage("nope")).toBe("nope");
  });
});
