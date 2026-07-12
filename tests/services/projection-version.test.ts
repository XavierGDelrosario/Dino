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
import { CURRENT_PROJECTION_VERSION, FRESH_OR_MT } from "@/lib/projection";

const EDGE = readFileSync("supabase/functions/translate/index.ts", "utf8");

describe("projection version (client ↔ edge mirror)", () => {
  it("matches the edge function's CURRENT_PROJECTION_VERSION", () => {
    const match = EDGE.match(/const CURRENT_PROJECTION_VERSION = (\d+);/);
    expect(match, "edge must declare CURRENT_PROJECTION_VERSION").not.toBeNull();
    expect(Number(match![1])).toBe(CURRENT_PROJECTION_VERSION);
  });

  it("gates the cache read on freshness, exempting the PAID MT rows", () => {
    // MT rows project nothing, so a version bump must never make them 'stale' — that
    // would re-call Google for every MT-cached word and turn a bump into a spend event.
    expect(FRESH_OR_MT).toBe(
      `projection_version.gte.${CURRENT_PROJECTION_VERSION},dictionary_ref.like.mt:*`,
    );
  });

  it("applies that same gate on BOTH edge cache reads (single + batch)", () => {
    // fetchVerified and fetchVerifiedMany. Miss either one and stale rows keep serving.
    const gated = EDGE.match(/\.or\(FRESH_OR_MT\)/g) ?? [];
    expect(gated).toHaveLength(2);
  });
});
