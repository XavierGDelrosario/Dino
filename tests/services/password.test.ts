import { describe, it, expect } from "vitest";
import { checkPassword } from "@/lib/password";

describe("checkPassword (password policy)", () => {
  it("rejects too-short passwords", () => {
    expect(checkPassword("aB3")).toBe("short");
    expect(checkPassword("abc12")).toBe("short"); // 5 < 8
  });

  it("rejects letters-only or digits-only (needs both)", () => {
    expect(checkPassword("abcdefgh")).toBe("weak");
    expect(checkPassword("12345678")).toBe("weak");
  });

  it("accepts ≥8 with letters + digits", () => {
    expect(checkPassword("password123")).toBeNull();
    expect(checkPassword("aB3aB3aB")).toBeNull();
  });
});
