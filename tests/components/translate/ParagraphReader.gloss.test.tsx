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

  it("asks for the REST when only some sentences have been bought", () => {
    // The gate used to be "no gloss at all", so tapping one sentence and then
    // pressing the toggle silently skipped the rest. Now that the press also runs
    // the full submit, that gate stopped a partially-tapped text from ever running it.
    const { onLoadGloss } = renderLazy({
      sentences: [SENTENCES[0], { ...SENTENCES[1], gloss: null }],
    });
    fireEvent.click(toggle());
    expect(onLoadGloss).toHaveBeenCalledTimes(1);
  });

  it("opens with the English already showing when it was ASKED for", () => {
    // The press happens on the LIVE reader, which is then replaced by this one. The
    // gloss it paid for must not come up hidden, or the press reads as a no-op.
    render(
      <LocaleProvider>
        <ParagraphReader
          text={TEXT}
          tokens={TOKENS}
          meaningsByWord={MEANINGS}
          sentences={SENTENCES}
          openGloss
          saved={new Set()}
          confidence={new Map()}
          lists={[]}
          onAdd={async () => {}}
          onCreateList={async () => "list-1"}
        />
      </LocaleProvider>,
    );
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    // …and it still puts it away.
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(screen.queryByText("The cat ran.")).toBeNull();
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

  it("the toggle puts away tapped lines too — off means OFF", () => {
    // Tapping a sentence and then switching the toggle on and off used to leave
    // that line's English on screen, so the toggle looked like it had failed.
    const { container } = renderTappable();
    fireEvent.click(marks(container)[0]);
    expect(screen.getByText("The cat ran.")).toBeTruthy();

    const toggle = screen.getByRole("button", { name: /Show translation/ });
    fireEvent.click(toggle); // on — everything shows
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(2);

    fireEvent.click(toggle); // off — nothing shows, including the tapped line
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(0);
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

  it("gives unpunctuated text NO per-sentence controls — the whole gloss answers instead", () => {
    // Recognized speech rarely punctuates and headlines never do. Those sentences
    // used to get a stand-in marker: a pressable thing with no glyph in the source,
    // unfindable unless you already knew it was there. Now the text keeps its
    // controls-free flow and "Show translation" prints the lot in one block.
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

    expect(container.querySelectorAll(".reader__punct")).toHaveLength(0);
    // The reader renders exactly the source, controls or not.
    expect((container.querySelector(".reader") as HTMLElement).textContent).toBe(TWO_LINES);

    // Nothing inline, before or after the toggle — the block below carries it all.
    expect(container.querySelector(".reader__whole")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(0);
    expect((container.querySelector(".reader__whole") as HTMLElement).textContent).toBe(
      "The cat ran. The dog slept.",
    );
  });

  it("keeps the per-sentence layout as soon as ONE sentence is punctuated", () => {
    // Mixed text still hangs its English off the marks it does have; only the
    // wholly-unpunctuated case falls back to the block.
    const { container } = renderTappable();
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(container.querySelectorAll(".reader__gloss")).toHaveLength(2);
    expect(container.querySelector(".reader__whole")).toBeNull();
  });

  it("in MIXED text, only the punctuated sentence gets a control", () => {
    // A line break ends the first sentence with no mark on it. It gets nothing —
    // and, critically, the second sentence's 。 stays with the SECOND sentence
    // rather than drifting up to close the first (the old placement regression,
    // back when an unpunctuated line still claimed a control of its own).
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
    expect(controls).toHaveLength(1);
    expect(controls[0].textContent).toBe("。");
    // It sits AFTER the second sentence's text, not up beside the first.
    const rendered = paragraph.innerHTML.indexOf(controls[0].outerHTML);
    expect(rendered).toBeGreaterThan(-1);
    expect(paragraph.innerHTML.slice(0, rendered)).toContain("犬");
    // One punctuated sentence is enough to keep the inline layout.
    expect(container.querySelector(".reader__whole")).toBeNull();
    // Pressing it answers for the sentence it closes, and only that one.
    fireEvent.click(controls[0]);
    expect(screen.getByText("The dog slept.")).toBeTruthy();
    expect(screen.queryByText("The cat ran.")).toBeNull();
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
