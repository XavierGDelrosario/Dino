import { describe, expect, it } from "vitest";
import { httpUrl } from "@/lib/safeUrl";

describe("httpUrl", () => {
  it("passes http and https through (trimmed)", () => {
    expect(httpUrl("https://ja.wikinews.org/wiki/x")).toBe("https://ja.wikinews.org/wiki/x");
    expect(httpUrl("  http://example.com ")).toBe("http://example.com");
    expect(httpUrl("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
  });
  it("refuses every other scheme and non-URLs", () => {
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,hi", "vbscript:x", "ftp://x", "example.com", "", null, undefined, "https://with space"]) {
      expect(httpUrl(bad)).toBeUndefined();
    }
  });
});
