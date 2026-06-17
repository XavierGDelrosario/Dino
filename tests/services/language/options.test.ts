import { describe, it, expect } from "vitest";
import { targetOptions, sourceOptions } from "@/services/language/options";
import { SUPPORTED_LANGUAGES } from "@/services/language/registry";
import { AUTO_DETECT } from "@/services/language/detect";

describe("targetOptions", () => {
  it("is every supported language", () => {
    expect(targetOptions()).toEqual(SUPPORTED_LANGUAGES);
  });
});

describe("sourceOptions", () => {
  it("leads with the AUTO_DETECT sentinel, then every language", () => {
    const opts = sourceOptions();
    expect(opts[0].code).toBe(AUTO_DETECT);
    expect(opts.slice(1).map((o) => o.code)).toEqual(
      SUPPORTED_LANGUAGES.map((l) => l.code)
    );
  });
});
