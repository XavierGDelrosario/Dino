// The projection version is DUPLICATED across two runtimes: src/lib/projection.ts
// (browser/Vite) and supabase/functions/translate/index.ts (Deno — it cannot import
// from src/). Both the client and the edge gate their `words` cache reads on it, so if
// they drift the two disagree about what "stale" means: the client would serve a row
// the edge considers stale (or bounce to the edge for a row the edge thinks is fine,
// re-projecting on every single lookup).
//
// Same discipline as the other hand-mirrored edge logic (toWord, the onConflict tuple).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CURRENT_PROJECTION_VERSION, FRESH } from "@/lib/projection";

const EDGE = readFileSync("supabase/functions/translate/index.ts", "utf8");

describe("projection version (client ↔ edge mirror)", () => {
  it("matches the edge function's CURRENT_PROJECTION_VERSION", () => {
    const match = EDGE.match(/const CURRENT_PROJECTION_VERSION = (\d+);/);
    expect(match, "edge must declare CURRENT_PROJECTION_VERSION").not.toBeNull();
    expect(Number(match![1])).toBe(CURRENT_PROJECTION_VERSION);
  });

  it("gates the cache read on freshness, with NO exemption for MT rows", () => {
    // MT rows are gated too (v8): exempting them froze an MT answer forever, since the
    // row always won the cache read and the dictionary was never re-consulted.
    expect(FRESH).toBe(`projection_version.gte.${CURRENT_PROJECTION_VERSION}`);
    expect(FRESH).not.toContain("mt:");
  });

  it("applies that same gate on BOTH edge cache reads (single + batch)", () => {
    // fetchVerified and fetchVerifiedMany. Miss either one and stale rows keep serving.
    const gated = EDGE.match(/\.or\(FRESH\)/g) ?? [];
    expect(gated).toHaveLength(2);
  });

  it("keeps a version bump FREE: a stale MT row is revived, never re-bought", () => {
    // The safety net for gating MT rows. Both paths (single + batch) must consult
    // reviveMtRows BEFORE callTranslationProvider, or a bump re-calls Google for every
    // MT-cached word — the exact spend event the old exemption existed to prevent.
    expect(EDGE).toMatch(/async function reviveMtRows/);
    const revives = EDGE.match(/await reviveMtRows\(/g) ?? [];
    expect(revives).toHaveLength(2);
    expect(EDGE.indexOf("await reviveMtRows(")).toBeLessThan(EDGE.indexOf("await callTranslationProvider("));
  });
});
