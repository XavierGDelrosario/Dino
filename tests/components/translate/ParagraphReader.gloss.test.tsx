// @vitest-environment jsdom
// The reader's INLINE translation: each sentence followed by its own English,
// so reading a line never means looking away to a separate block.
//
// What's pinned here is the property the whole design rests on — a rendered
// sentence and the gloss beneath it are the SAME span of text. The per-sentence
// MT call guarantees that at the service layer (tests/services/lookup.test.ts);
// this asserts the view doesn't lose it, and that the Japanese is never altered
// or dropped by the toggle.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";
import type { SentenceGloss } from "@/services/lookup";

const TEXT = "猫が走った。犬が寝た。";

const TOKENS: AnalyzedToken[] = [
  { text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: "名詞" },
  { text: "走った", start: 2, end: 5, reading: "はしった", lemma: "走る", pos: "動詞" },
  { text: "犬", start: 6, end: 7, reading: "いぬ", lemma: "犬", pos: "名詞" },
  { text: "寝た", start: 8, end: 10, reading: "ねた", lemma: "寝る", pos: "動詞" },
];

const SENTENCES: SentenceGloss[] = [
  { text: "猫が走った。", start: 0, end: 6, gloss: "The cat ran." },
  { text: "犬が寝た。", start: 6, end: 11, gloss: "The dog slept." },
];

const MEANINGS = new Map([
  ["猫", [makeWord({ wordId: "w-neko", input: "猫", translation: "cat" })]],
  ["犬", [makeWord({ wordId: "w-inu", input: "犬", translation: "dog" })]],
]);

function renderReader(sentences: SentenceGloss[] = SENTENCES) {
  return render(
    <LocaleProvider>
      <ParagraphReader
        text={TEXT}
        tokens={TOKENS}
        meaningsByWord={MEANINGS}
        sentences={sentences}
        saved={new Set()}
        confidence={new Map()}
        lists={[]}
        onAdd={async () => {}}
        onCreateList={async () => "list-1"}
      />
    </LocaleProvider>,
  );
}

const toggle = () => screen.getByRole("button", { name: /Show translation/ });

afterEach(cleanup);

describe("ParagraphReader — inline translation", () => {
  it("hides the translation until the toggle is pressed", () => {
    const { container } = renderReader();
    expect(screen.queryByText("The cat ran.")).toBeNull();
    expect(container.textContent).toContain("猫が走った。犬が寝た。");

    fireEvent.click(toggle());
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    expect(screen.getByText("The dog slept.")).toBeTruthy();
  });

  it("keeps the Japanese in ONE paragraph — English never re-lays-out the text", () => {
    const { container } = renderReader();
    expect(container.querySelectorAll(".reader")).toHaveLength(1);

    fireEvent.click(toggle());

    // Still a single paragraph: the reader must not split into a row per sentence,
    // which is what used to re-wrap the Japanese the moment English appeared.
    expect(container.querySelectorAll(".reader")).toHaveLength(1);
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(2);
  });

  it("puts each gloss DIRECTLY under its own sentence, in order", () => {
    const { container } = renderReader();
    fireEvent.click(toggle());

    const paragraph = container.querySelector(".reader") as HTMLElement;
    const lines = [...paragraph.querySelectorAll(".reader__gloss")].map((n) => n.textContent);
    expect(lines).toEqual(["The cat ran.", "The dog slept."]);
    // Position, not just order: each gloss follows the sentence it translates, so
    // the source reads 猫… → its English → 犬… → its English.
    expect(paragraph.textContent).toBe("猫が走った。The cat ran.犬が寝た。The dog slept.");
  });

  it("renders every character of the source, translation on or off", () => {
    // The guard that injecting English never drops or duplicates Japanese: strip
    // the gloss nodes and what remains must be exactly the source text.
    const { container } = renderReader();
    const source = () => {
      const clone = (container.querySelector(".reader") as HTMLElement).cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".reader__gloss").forEach((n) => n.remove());
      return clone.textContent;
    };

    expect(source()).toBe(TEXT);
    fireEvent.click(toggle());
    expect(source()).toBe(TEXT);
  });

  it("keeps words interactive (hover targets survive the sentence split)", () => {
    const { container } = renderReader();
    fireEvent.click(toggle());
    // 猫 and 犬 have dictionary senses and aren't saved → addable ("new").
    expect(container.querySelectorAll(".tok--new")).toHaveLength(2);
  });

  it("skips a sentence MT couldn't translate, and keeps the Japanese intact", () => {
    const { container } = renderReader([
      SENTENCES[0],
      { ...SENTENCES[1], gloss: null },
    ]);
    fireEvent.click(toggle());

    const lines = [...container.querySelectorAll(".reader__gloss")].map((n) => n.textContent);
    expect(lines).toEqual(["The cat ran."]); // only the one that resolved
    expect((container.querySelector(".reader") as HTMLElement).textContent).toContain("犬が寝た。");
  });

  it("offers no toggle at all when there is no translation to show", () => {
    renderReader([]);
    expect(screen.queryByRole("button", { name: /Show translation/ })).toBeNull();
  });
});

// PAY ON DEMAND: an article is analyzed with skipGloss (opening one must cost
// nothing), so the reader starts with no sentences at all. The toggle is still
// offered, and the FIRST press is what buys the translation — a reader who never
// asks for English never spends.
describe("ParagraphReader — on-demand gloss", () => {
  function renderLazy(opts: { sentences?: SentenceGloss[]; glossLoading?: boolean } = {}) {
    const onLoadGloss = vi.fn();
    const view = render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT}
          tokens={TOKENS}
          meaningsByWord={MEANINGS}
          sentences={opts.sentences ?? []}
          onLoadGloss={onLoadGloss}
          glossLoading={opts.glossLoading ?? false}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );
    return { ...view, onLoadGloss };
  }

  it("offers the toggle with no translation yet, and buys it on first press", () => {
    const { onLoadGloss } = renderLazy();
    expect(onLoadGloss).not.toHaveBeenCalled(); // opening costs nothing
    fireEvent.click(toggle());
    expect(onLoadGloss).toHaveBeenCalledTimes(1);
  });

  it("does not buy it again once the translation is held", () => {
    const { onLoadGloss } = renderLazy({ sentences: SENTENCES });
    fireEvent.click(toggle()); // show
    fireEvent.click(toggle()); // hide
    fireEvent.click(toggle()); // show again
    expect(onLoadGloss).not.toHaveBeenCalled();
  });

  it("keeps showing the Japanese while the translation is in flight", () => {
    const { container } = renderLazy({ glossLoading: true });
    // Disabled while loading, so a second press can't buy it twice.
    expect(screen.getByRole("button", { name: /Translating sentences/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(container.querySelector(".reader")?.textContent).toContain(TEXT);
  });

  it("shows no toggle when there is neither a translation nor a way to get one", () => {
    render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT}
          tokens={TOKENS}
          meaningsByWord={MEANINGS}
          sentences={[]}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );
    expect(screen.queryByRole("button", { name: /Show translation/ })).toBeNull();
  });
});

describe("ParagraphReader — tapping a sentence's punctuation", () => {
  // Tapping 。 is a request to read THAT line now, so it must not also require the
  // toggle; but a paragraph that merely arrives with glosses still keeps them
  // hidden, because the reader is for reading the Japanese.
  const renderTappable = (onTranslateSentence = vi.fn()) =>
    render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT}
          tokens={TOKENS}
          meaningsByWord={MEANINGS}
          sentences={SENTENCES}
          onTranslateSentence={onTranslateSentence}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );

  const marks = (c: HTMLElement) => c.querySelectorAll(".reader__punct");

  it("turns each sentence's closing mark into its own control", () => {
    const { container } = renderTappable();
    expect(marks(container)).toHaveLength(2); // one per sentence, not per token
    expect(marks(container)[0].textContent).toBe("。");
  });

  it("asks for THAT sentence, and shows it without the toggle", () => {
    const onTranslate = vi.fn();
    const { container } = renderTappable(onTranslate);
    expect(screen.queryByText("The cat ran.")).toBeNull();

    fireEvent.click(marks(container)[0]);
    expect(onTranslate).toHaveBeenCalledWith(0);
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    // The line NOT asked for stays Japanese-only.
    expect(screen.queryByText("The dog slept.")).toBeNull();
  });

  it("each tapped sentence keeps its own English — they don't replace each other", () => {
    const { container } = renderTappable();
    fireEvent.click(marks(container)[0]);
    expect(screen.getByText("The cat ran.")).toBeTruthy();

    fireEvent.click(marks(container)[1]);
    // Both stay: the translations are part of the text now, not one transient card.
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    expect(screen.getByText("The dog slept.")).toBeTruthy();
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(2);
  });

  it("hides again when the SAME control is pressed twice", () => {
    const { container } = renderTappable();
    fireEvent.click(marks(container)[0]);
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    fireEvent.click(marks(container)[0]);
    expect(screen.queryByText("The cat ran.")).toBeNull();
  });

  it("puts the English under the sentence it belongs to, and only that one", () => {
    const { container } = renderTappable();
    fireEvent.click(marks(container)[0]);

    const paragraph = container.querySelector(".reader") as HTMLElement;
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(1);
    // Position: the English follows the sentence it translates, and the second
    // sentence is still untouched Japanese.
    expect(paragraph.textContent).toBe("猫が走った。The cat ran.犬が寝た。");
  });

  it("gives a sentence that ends WITHOUT punctuation its own control", () => {
    // Recognized speech rarely punctuates, and headlines/list items never do — those
    // sentences had no control at all, so they could not be translated.
    const TWO_LINES = "猫が走った\n犬が寝た";
    const { container } = render(
      <LocaleProvider>
        <ParagraphReader
          text={TWO_LINES}
          tokens={[
            { text: "猫", start: 0, end: 1, reading: null, lemma: null, pos: "名詞" },
            { text: "走っ", start: 2, end: 4, reading: null, lemma: null, pos: "動詞" },
            { text: "犬", start: 6, end: 7, reading: null, lemma: null, pos: "名詞" },
            { text: "寝", start: 8, end: 9, reading: null, lemma: null, pos: "動詞" },
          ]}
          meaningsByWord={MEANINGS}
          sentences={[
            { text: "猫が走った", start: 0, end: 5, gloss: "The cat ran." },
            { text: "犬が寝た", start: 6, end: 10, gloss: "The dog slept." },
          ]}
          onTranslateSentence={vi.fn()}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );

    const implicit = container.querySelectorAll(".reader__punct--implicit");
    expect(implicit).toHaveLength(2); // one per unpunctuated sentence
    // The marker's glyph lives in CSS, so the text still reads exactly as the source.
    expect((container.querySelector(".reader") as HTMLElement).textContent).toBe(TWO_LINES);

    fireEvent.click(implicit[1]);
    expect(screen.getByText("The dog slept.")).toBeTruthy();
  });

  it("puts the control at its OWN sentence's end, not past the line break", () => {
    // The regression: when a sentence ended before its gap did (untokenized trailing
    // text, then a newline), the control was emitted after the WHOLE gap — landing
    // beside the next sentence instead of closing its own.
    const TEXT2 = "猫が走った\n犬が寝た。";
    const { container } = render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT2}
          tokens={[
            { text: "猫", start: 0, end: 1, reading: null, lemma: null, pos: "名詞" },
            { text: "走っ", start: 2, end: 4, reading: null, lemma: null, pos: "動詞" },
            { text: "犬", start: 6, end: 7, reading: null, lemma: null, pos: "名詞" },
            { text: "寝", start: 8, end: 9, reading: null, lemma: null, pos: "動詞" },
          ]}
          meaningsByWord={MEANINGS}
          sentences={[
            { text: "猫が走った", start: 0, end: 5, gloss: "The cat ran." },
            { text: "犬が寝た。", start: 6, end: 11, gloss: "The dog slept." },
          ]}
          onTranslateSentence={vi.fn()}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );

    const paragraph = container.querySelector(".reader") as HTMLElement;
    const controls = [...paragraph.querySelectorAll(".reader__punct")];
    expect(controls).toHaveLength(2);
    // First control closes the FIRST sentence: everything before it is that
    // sentence's text, and the line break has not happened yet.
    const before = (paragraph.textContent ?? "").indexOf("犬");
    const rendered = paragraph.innerHTML.indexOf(controls[0].outerHTML);
    expect(rendered).toBeGreaterThan(-1);
    expect(paragraph.innerHTML.slice(0, rendered)).not.toContain("犬");
    expect(before).toBeGreaterThan(0);
    // …and the second is the real terminator of the second sentence.
    expect(controls[1].textContent).toBe("。");
  });

  it("lifts a translated sentence onto its own line, alongside its English", () => {
    // The alignment fix: a sentence starting mid-line put its translation under
    // whatever happened to be to its left. Given its own block, sentence and English
    // start at the same edge with nothing measured.
    const { container } = renderTappable();
    expect(container.querySelectorAll(".reader__sentence")).toHaveLength(0);

    fireEvent.click(marks(container)[0]);

    const blocks = container.querySelectorAll(".reader__sentence");
    expect(blocks).toHaveLength(1); // only the translated one is lifted out
    expect(blocks[0].textContent).toBe("猫が走った。The cat ran.");
    // The untranslated sentence keeps flowing in the paragraph.
    expect((container.querySelector(".reader") as HTMLElement).textContent).toContain("犬が寝た。");
  });

  it("has no marks when no per-sentence handler is given", () => {
    const { container } = render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT}
          tokens={TOKENS}
          meaningsByWord={MEANINGS}
          sentences={SENTENCES}
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );
    expect(marks(container)).toHaveLength(0);
  });
});
