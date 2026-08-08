import { describe, it, expect } from "vitest";
import { errorMessage } from "@/lib/errorMessage";
import { ServiceError } from "@/services/errors";

// The rule is about WHO WROTE the message, not about the error type: a provider code
// means the text came from Postgres and is internals; no code means a service authored
// it for the reader.
describe("errorMessage", () => {
  it("replaces a coded database error with copy keyed on its kind", () => {
    const e = new ServiceError(
      'duplicate key value violates unique constraint "uq_user_words_custom"',
      "conflict",
      { code: "23505" },
    );
    expect(errorMessage(e)).toBe("That already exists.");
  });

  it("never leaks schema internals for any coded kind", () => {
    for (const [kind, code] of [["permission", "42501"], ["not_found", "PGRST116"], ["unknown", "XX000"]] as const) {
      const e = new ServiceError('relation "user_words" does not exist', kind, { code });
      expect(errorMessage(e)).not.toMatch(/user_words|relation/);
    }
  });

  it("KEEPS an app-authored message — no code means it was written for the reader", () => {
    const e = new ServiceError("You've filed a lot of reports today — thanks.", "validation");
    expect(errorMessage(e)).toMatch(/lot of reports today/);
  });

  // Supabase Auth messages are user-meaningful and are not schema internals.
  it("keeps a plain Error's message", () => {
    expect(errorMessage(new Error("Invalid login credentials"))).toBe("Invalid login credentials");
  });

  it("still handles the thrown plain objects PostgREST produces", () => {
    expect(errorMessage({ message: "network error" })).toBe("network error");
    expect(errorMessage("boom")).toBe("boom");
  });
});
