// The soften ("Forgot") cap, checked against the confidence bands it has to land in.
//
// `confidence_from_stability`'s cuts (1 / 3 / 7 / 16 / 35 days) are written in THREE
// places already — the SQL function, `services/confidence.ts`, and the tests that pin
// it. `soften_confidence` adds a fourth copy, as the band TOPS it clamps stability to
// (0.9 / 2.5 / 6 / 15 / 34), hand-derived from those cuts and linked to them by
// nothing at all.
//
// So a change to a cut — raising 5/5 to 45 days, say — silently puts the cap in the
// wrong band, and "Forgot" drops two notches or none. The unit gate would stay green,
// because no unit test runs SQL.
//
// Rather than match the literals, this asserts the PROPERTY that has to hold: the cap
// for target bucket N must itself read as bucket N. That survives re-tuning the caps
// and fails only on real drift.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { confidenceFromStability } from "@/services/confidence";

const DIR = "supabase/migrations";

/** The LAST migration defining soften_confidence — the one whose body is live. */
function liveSoftenSql(): string {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(DIR, f), "utf8").includes("FUNCTION soften_confidence"));
  expect(files.length, "no migration defines soften_confidence").toBeGreaterThan(0);
  return readFileSync(join(DIR, files[files.length - 1]), "utf8");
}

/** The `v_cap := CASE v_target WHEN n THEN x … ELSE y END` mapping, as bucket → cap. */
function capsByTarget(sql: string): Map<number, number> {
  const start = sql.indexOf("v_cap := CASE v_target");
  expect(start, "v_cap CASE not found").toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf("END", start));
  const caps = new Map<number, number>();
  for (const m of block.matchAll(/WHEN\s+(\d+)\s+THEN\s+([\d.]+)/g)) {
    caps.set(Number(m[1]), Number(m[2]));
  }
  const fallback = block.match(/ELSE\s+([\d.]+)/);
  expect(fallback, "no ELSE arm").not.toBeNull();
  caps.set(4, Number(fallback![1])); // the ELSE covers target 4 (softening down from 5)
  return caps;
}

describe("soften_confidence's stability cap vs the confidence bands", () => {
  const caps = capsByTarget(liveSoftenSql());

  it("covers every target bucket a soften can produce (0–4)", () => {
    expect([...caps.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([...caps.entries()])(
    "caps target %i at %f days, which reads back as that same bucket",
    (target, cap) => {
      expect(confidenceFromStability(cap)).toBe(target);
    },
  );

  // A hair INSIDE the band, never sitting on the cut: at the cut exactly, float noise
  // can round back up into the band above and the press appears to do nothing.
  it("sits strictly below the cut that opens the next band up", () => {
    for (const [target, cap] of caps) {
      expect(confidenceFromStability(cap), `bucket ${target}`).toBe(target);
      expect(confidenceFromStability(cap + 1e-9), `bucket ${target} + epsilon`).toBe(target);
    }
  });
});
