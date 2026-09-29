// The vocabulary cache is kept current by WRITE-THROUGH from the services that write
// user_words / list_words / lists (services/words/vocabularyCache.ts). That only holds
// while every such write lives in those services — a write added anywhere else would
// leave the Lists tab showing stale data with nothing to say so. This pins it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "../../../src");
const ALLOWED = new Set([
  "services/words/userWords.ts",
  "services/review.ts",
  "services/lists.ts",
]);

/** RPCs that write the vocabulary, and direct table writes. */
const WRITE_RPC = /rpc\(\s*"(save_dictionary_words?|create_custom_word|record_review|soften_confidence)"/;
const TABLE_WRITE = /from\(\s*"(user_words|list_words|lists)"\s*\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "types" ? [] : files(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("vocabulary write paths", () => {
  it("only the three write-through services write user_words / list_words / lists", () => {
    const offenders = files(SRC)
      .map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }))
      .filter(({ text }) => WRITE_RPC.test(text) || TABLE_WRITE.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it("the three services do write — the patterns still match what they call", () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC, rel), "utf8");
      expect(WRITE_RPC.test(text) || TABLE_WRITE.test(text), rel).toBe(true);
    }
  });
});
