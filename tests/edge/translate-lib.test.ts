// Unit tests for the `translate` edge function's PURE helpers (extracted to
// supabase/functions/translate/_lib.ts so they run in Node/Vitest — the Deno
// edge file itself can't be imported here). Covers the high-bug-density logic:
// JWT decode, CORS resolution, lang mapping, and the dedupe/dictionary_ref
// projection that CLAUDE.md flags as breaking common words if dropped.
import { describe, it, expect } from "vitest";
import {
  corsHeaders,
  parseAllowedOrigins,
  projectRows,
  toGoogleLang,
  userIdFromAuth,
  type ProviderResult,
} from "../../supabase/functions/translate/_lib";

/** Build a JWT-shaped token (unpadded base64url payload, like a real JWT). */
function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("toGoogleLang", () => {
  it("lowercases app codes to ISO-639-1", () => {
    expect(toGoogleLang("JA")).toBe("ja");
    expect(toGoogleLang("EN")).toBe("en");
    expect(toGoogleLang("KO")).toBe("ko");
    expect(toGoogleLang("ZH")).toBe("zh");
  });
  it("maps split-script Chinese to regional codes", () => {
    expect(toGoogleLang("ZH-Hant")).toBe("zh-TW");
    expect(toGoogleLang("ZH-Hans")).toBe("zh-CN");
  });
  it("trims surrounding whitespace", () => {
    expect(toGoogleLang("  JA  ")).toBe("ja");
  });
});

describe("userIdFromAuth", () => {
  it("returns the `sub` from a Bearer token", () => {
    expect(userIdFromAuth(`Bearer ${jwtWith({ sub: "user-123" })}`)).toBe("user-123");
  });
  it("works without the Bearer prefix and restores base64url padding", () => {
    // a sub length chosen so the payload's base64 needs padding
    expect(userIdFromAuth(jwtWith({ sub: "abcde" }))).toBe("abcde");
  });
  it("returns null for a token with no sub (e.g. the anon api key)", () => {
    expect(userIdFromAuth(`Bearer ${jwtWith({ role: "anon" })}`)).toBeNull();
  });
  it("returns null for a missing header", () => {
    expect(userIdFromAuth(null)).toBeNull();
  });
  it("returns null for a malformed token (doesn't throw)", () => {
    expect(userIdFromAuth("Bearer not-a-jwt")).toBeNull();
    expect(userIdFromAuth("garbage")).toBeNull();
    expect(userIdFromAuth("Bearer a.!!!.c")).toBeNull();
  });
});

describe("parseAllowedOrigins", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseAllowedOrigins("https://a.com, https://b.com ,")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(null)).toEqual([]);
  });
});

describe("corsHeaders", () => {
  it("an empty allow-list grants '*' (dev)", () => {
    expect(corsHeaders("https://anything.com", [])["Access-Control-Allow-Origin"]).toBe("*");
  });
  it("echoes an allowed origin (and sets Vary: Origin)", () => {
    const h = corsHeaders("https://app.dino.com", ["https://app.dino.com", "https://dino.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.dino.com");
    expect(h["Vary"]).toBe("Origin");
  });
  it("denies a disallowed origin with 'null'", () => {
    expect(
      corsHeaders("https://evil.com", ["https://app.dino.com"])["Access-Control-Allow-Origin"],
    ).toBe("null");
  });
  it("denies a missing Origin against a non-empty list", () => {
    expect(corsHeaders(null, ["https://app.dino.com"])["Access-Control-Allow-Origin"]).toBe("null");
  });
});

describe("projectRows", () => {
  const JA_SENSE: ProviderResult = {
    translation: "cat (esp. the domestic cat)",
    inputReading: "ねこ",
    headword: "猫",
    entryId: "1467640",
    sensePos: 0,
  };

  it("JA→EN: stores the headword as input and builds ref '<entry>:<pos>'", () => {
    const [row] = projectRows([JA_SENSE], "ねこ", "JA", "EN", 2);
    expect(row.input).toBe("猫"); // canonical headword, not the kana search term
    expect(row.dictionary_ref).toBe("1467640:0");
    expect(row.input_reading).toBe("ねこ");
    expect(row.jmdict_entry_id).toBe("1467640");
    expect(row.projection_version).toBe(2);
    expect(row.is_verified).toBe(true);
  });

  it("EN→JA: no headword + entryId → ref '<input>:<entry>'", () => {
    const enja: ProviderResult = {
      translation: "猫",
      translationReading: "ねこ",
      entryId: "1467640",
      sensePos: 0,
    };
    const [row] = projectRows([enja], "cat", "EN", "JA", 2);
    expect(row.input).toBe("cat"); // EN search term kept as-is (no headword)
    expect(row.dictionary_ref).toBe("cat:1467640");
    expect(row.translation_reading).toBe("ねこ");
  });

  it("MT fallback: no entryId → ref 'mt:<input>', input is the search term", () => {
    const mt: ProviderResult = { translation: "[MT] hi" };
    const [row] = projectRows([mt], "やあ", "JA", "EN", 2);
    expect(row.dictionary_ref).toBe("mt:やあ");
    expect(row.input).toBe("やあ");
    expect(row.jmdict_entry_id).toBeNull();
    expect(row.jmdict_sense_pos).toBeNull();
  });

  it("DEDUPEs senses that collapse to the same (headword, translation) — the 私→'I; me' x2 / Postgres 21000 guard", () => {
    const dupe: ProviderResult = { translation: "I; me", headword: "私", entryId: "1311110", sensePos: 0 };
    const dupe2: ProviderResult = { translation: "I; me", headword: "私", entryId: "1311110", sensePos: 1 };
    const rows = projectRows([dupe, dupe2], "私", "JA", "EN", 2);
    expect(rows).toHaveLength(1); // second dropped → no duplicate onConflict key
    expect(rows[0].dictionary_ref).toBe("1311110:0"); // keeps the first (primary)
  });

  it("keeps distinct translations of the same headword as separate rows", () => {
    const a: ProviderResult = { translation: "spicy", headword: "辛い", entryId: "1365850", sensePos: 0 };
    const b: ProviderResult = { translation: "painful", headword: "辛い", entryId: "1365860", sensePos: 0 };
    const rows = projectRows([a, b], "辛い", "JA", "EN", 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dictionary_ref)).toEqual(["1365850:0", "1365860:0"]);
  });

  it("defaults a null sensePos to 0 in the ref", () => {
    const r: ProviderResult = { translation: "x", headword: "字", entryId: "999", sensePos: null };
    expect(projectRows([r], "字", "JA", "EN", 2)[0].dictionary_ref).toBe("999:0");
  });
});
