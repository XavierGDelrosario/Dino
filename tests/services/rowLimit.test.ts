// The row-cap seam: the database message is parsed once, toServiceError gives it its
// own kind AND announces it, and the UI copy names what was capped.
import { describe, it, expect, vi } from "vitest";
import { parseRowLimit, onRowLimit } from "@/services/rowLimit";
import { toServiceError } from "@/services/errors";
import { errorMessage } from "@/lib/errorMessage";

describe("parseRowLimit", () => {
  it("reads the table and ceiling from user_rows_cap()'s message", () => {
    expect(parseRowLimit("user_words limit reached (1000 rows)")).toEqual({ table: "user_words", max: 1000 });
    expect(parseRowLimit("lists limit reached (100 rows)")).toEqual({ table: "lists", max: 100 });
  });
  it("is null for any other message", () => {
    expect(parseRowLimit('new row for relation "user_words" violates check constraint')).toBeNull();
    expect(parseRowLimit(undefined)).toBeNull();
  });
});

describe("toServiceError on a row cap", () => {
  it("maps to kind 'limit', carries the hit, and announces it", () => {
    const seen: unknown[] = [];
    const off = onRowLimit((h) => seen.push(h));
    const e = toServiceError({ code: "23514", message: "user_words limit reached (1000 rows)" });
    off();
    expect(e.kind).toBe("limit");
    expect(e.limit).toEqual({ table: "user_words", max: 1000 });
    expect(seen).toEqual([{ table: "user_words", max: 1000 }]);
  });
  it("leaves other check violations as 'validation' and silent", () => {
    const fn = vi.fn();
    const off = onRowLimit(fn);
    const e = toServiceError({ code: "23514", message: "violates check constraint \"user_words_input_len\"" });
    off();
    expect(e.kind).toBe("validation");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("errorMessage for a row cap", () => {
  it("names what was capped instead of the generic validation copy", () => {
    const words = toServiceError({ code: "23514", message: "user_words limit reached (1000 rows)" });
    const lists = toServiceError({ code: "23514", message: "lists limit reached (100 rows)" });
    expect(errorMessage(words)).toMatch(/saved-word limit/);
    expect(errorMessage(lists)).toMatch(/list limit/);
  });
});
