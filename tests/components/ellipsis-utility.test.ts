// The .ellipsis utility — pinned, because every way of breaking it is SILENT.
//
// This clamp has been written from scratch and got wrong four separate times in this
// codebase (.lists__title, .result, .listcard__name, .profilemenu__email). Each looked
// like a different bug and none of them threw: the text just wrapped, or ran over its
// neighbours, and only a human noticing it on a phone caught any of them.
//
// So two things are asserted here. First that the utility still declares the whole set
// — drop `white-space` and long text wraps instead of clipping; drop `display: block`
// and the rule is inert on the <span>s it is mostly used on; drop `min-width` and it
// never engages inside a flex row. Second that nobody has quietly re-implemented it in
// a component file, which is how the four copies accumulated in the first place.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");
const COMMON = join(SRC, "components/common/common.css");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (e.endsWith(".css")) out.push(p);
  }
  return out;
}

/** The body of a rule, comments stripped (so a mention in prose isn't a declaration). */
function ruleBody(css: string, selector: string): string | null {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const i = bare.indexOf(`\n${selector} {`);
  if (i === -1) return null;
  return bare.slice(i + selector.length + 3, bare.indexOf("}", i));
}

describe(".ellipsis — the whole set, or it silently does nothing", () => {
  const body = ruleBody(readFileSync(COMMON, "utf8"), ".ellipsis");

  it("exists in common.css, where the shared rules live", () => {
    expect(body).not.toBeNull();
  });

  // Named one by one so a failure says WHICH guarantee was dropped and what breaks.
  const required: [string, string][] = [
    ["display: block", "text-overflow never applies to a non-replaced inline box"],
    ["min-width: 0", "a flex item won't shrink below its content without it"],
    ["overflow: hidden", "without it the text paints past its box instead of clipping"],
    ["white-space: nowrap", "without it the text wraps and there is no overflow to mark"],
    ["text-overflow: ellipsis", "the … itself"],
  ];
  for (const [decl, why] of required) {
    it(`declares ${decl} — ${why}`, () => {
      expect(body ?? "").toContain(decl);
    });
  }
});

describe(".ellipsis — not re-implemented anywhere else", () => {
  it("is the only rule in src/ that declares text-overflow", () => {
    const offenders: string[] = [];
    for (const f of cssFiles(SRC)) {
      const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      if (!css.includes("text-overflow")) continue;
      // common.css is allowed exactly one: the utility itself.
      const count = (css.match(/text-overflow\s*:/g) ?? []).length;
      const isCommon = f.endsWith("common.css");
      if (!isCommon || count !== 1) {
        offenders.push(`${f.replace(SRC, "src")} (${count})`);
      }
    }
    expect(
      offenders,
      "add the `ellipsis` class in the markup instead of re-declaring the clamp — " +
        "it is the set of five that matters, and a partial copy fails silently",
    ).toEqual([]);
  });
});
