// @vitest-environment jsdom
// The panel's PROSE goes through the reader — both pieces of it.
//
// The example sentence always did. The definition did not: `definition_source` is a
// monolingual definition in the SOURCE language, so on a JA→EN row it is Japanese prose
// sitting directly under a Japanese sentence — and it rendered as a dead <p> while every
// word in the sentence above it was tappable, furigana'd and addable.
//
// The other half of what's pinned here is that the two share ONE knowledge state. Run
// as two independent readers, a word occurring in both would be blue in one and green in
// the other the moment you added it from either.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/lookup")>()),
  translateParagraph: vi.fn(),
}));
vi.mock("@/services/words/userWords", () => ({
  getUserWordStates: vi.fn(),
  saveDictionaryWords: vi.fn(),
}));
vi.mock("@/services/lists", () => ({ listUserLists: vi.fn(), createList: vi.fn() }));

import { SenseExample } from "@/components/common/SenseExample";
import { translateParagraph } from "@/services/lookup";
import { getUserWordStates } from "@/services/words/userWords";
import { listUserLists } from "@/services/lists";

const EXAMPLE = "このいちごは甘い。";
const DEFINITION = "砂糖のような味。";

// 甘い appears in BOTH pieces — it is the word the shared knowledge state is about.
const AMAI = makeWord({ wordId: "w-amai", input: "甘い", translation: "sweet" });
const SATOU = makeWord({ wordId: "w-satou", input: "砂糖", translation: "sugar" });

const tok = (text: string, start: number) => ({
  text,
  start,
  end: start + text.length,
  reading: null,
  lemma: text,
  pos: "名詞",
});

const PARAS: Record<string, unknown> = {
  [EXAMPLE]: {
    input: EXAMPLE,
    tokens: [tok("いちご", 2), tok("甘い", 6)],
    meanings: new Map([["甘い", [AMAI]]]),
    sentences: [],
  },
  [DEFINITION]: {
    input: DEFINITION,
    tokens: [tok("砂糖", 0), tok("甘い", 5)],
    meanings: new Map([
      ["砂糖", [SATOU]],
      ["甘い", [AMAI]],
    ]),
    sentences: [],
  },
};

const renderPanel = (props: Partial<{ example: string | null; definitionSource: string | null }> = {}) =>
  render(
    <LocaleProvider>
      <SenseExample
        example={EXAMPLE}
        exampleGloss="This strawberry is sweet."
        definitionSource={DEFINITION}
        userId="user-1"
        sourceLang="JA"
        targetLang="EN"
        {...props}
      />
    </LocaleProvider>,
  );

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /example/i }));
/** A piece rendered through ParagraphReader, identified by the token spans it emits. */
const readers = () => Array.from(document.querySelectorAll(".senseex__reader"));
const readerText = (el: Element) =>
  Array.from(el.querySelectorAll("span.tok")).map((s) => s.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(translateParagraph).mockImplementation(
    async ({ input }) => PARAS[input] as never,
  );
  vi.mocked(getUserWordStates).mockResolvedValue(new Map());
  vi.mocked(listUserLists).mockResolvedValue([]);
});
afterEach(cleanup);

describe("SenseExample — the definition renders through the reader", () => {
  it("renders BOTH the sentence and the definition as readers", async () => {
    renderPanel();
    openPanel();
    await waitFor(() => expect(readers()).toHaveLength(2));
    expect(readerText(readers()[0])).toContain("いちご"); // the example
    expect(readerText(readers()[1])).toContain("砂糖"); // the definition
  });

  it("keeps the definition's own label above it", async () => {
    renderPanel();
    openPanel();
    await waitFor(() => expect(readers()).toHaveLength(2));
    // The label names the block, so it must survive the swap from plain text to reader.
    expect(document.querySelector(".senseex__label")?.textContent).toBeTruthy();
  });

  it("analyzes each piece once, and never buys a translation for either", async () => {
    renderPanel();
    openPanel();
    await waitFor(() => expect(translateParagraph).toHaveBeenCalledTimes(2));
    const inputs = vi.mocked(translateParagraph).mock.calls.map((c) => c[0].input);
    expect(inputs).toEqual([EXAMPLE, DEFINITION]);
    // Opening a reference surface must never bill Google — per piece.
    for (const [call] of vi.mocked(translateParagraph).mock.calls) {
      expect(call).toMatchObject({ skipGloss: true, dictionaryOnly: true });
    }
  });

  it("resolves the user's knowledge ONCE, across both pieces, with no duplicate ids", async () => {
    renderPanel();
    openPanel();
    await waitFor(() => expect(getUserWordStates).toHaveBeenCalled());
    expect(getUserWordStates).toHaveBeenCalledTimes(1);
    const ids = vi.mocked(getUserWordStates).mock.calls[0][0].dictionaryWordIds;
    // 甘い is in both pieces: one lookup, one answer, so it cannot end up coloured two
    // different ways in the same panel.
    expect([...ids].sort()).toEqual(["w-amai", "w-satou"]);
  });

  it("a row with only a definition still renders it as a reader, in its own slot", async () => {
    renderPanel({ example: null });
    openPanel();
    await waitFor(() => expect(readers()).toHaveLength(1));
    // Slot 0 stayed empty rather than collapsing, so the definition is analyzed as
    // itself and not served the (absent) example's tokens.
    expect(readerText(readers()[0])).toContain("砂糖");
    expect(translateParagraph).toHaveBeenCalledTimes(1);
    expect(vi.mocked(translateParagraph).mock.calls[0][0].input).toBe(DEFINITION);
  });
});
