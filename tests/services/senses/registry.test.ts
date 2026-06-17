import { describe, it, expect } from "vitest";
import { resolveSenseProvider } from "@/services/senses/registry";
import { mtFallbackProvider } from "@/services/senses/mtFallback";

describe("resolveSenseProvider", () => {
  it("falls back to the MT provider for every pair (registry is empty)", () => {
    expect(resolveSenseProvider("JA", "EN")).toBe(mtFallbackProvider);
    expect(resolveSenseProvider("EN", "JA")).toBe(mtFallbackProvider);
    expect(resolveSenseProvider("EN", "ES")).toBe(mtFallbackProvider);
  });
});
