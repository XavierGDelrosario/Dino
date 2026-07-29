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

  it("puts each gloss with the sentence it translates, not the other one", () => {
    const { container } = renderReader();
    fireEvent.click(toggle());

    const pairs = container.querySelectorAll(".reader__pair");
    expect(pairs).toHaveLength(2);
    // Each row holds exactly one sentence and exactly its own translation.
    expect(within(pairs[0] as HTMLElement).getByText("The cat ran.")).toBeTruthy();
    expect((pairs[0] as HTMLElement).textContent).toContain("猫が走った。");
    expect((pairs[0] as HTMLElement).textContent).not.toContain("犬が寝た。");
    expect(within(pairs[1] as HTMLElement).getByText("The dog slept.")).toBeTruthy();
    expect((pairs[1] as HTMLElement).textContent).toContain("犬が寝た。");
  });

  it("renders every character of the source in both layouts", () => {
    const { container } = renderReader();
    const japaneseOnly = (el: HTMLElement) =>
      (el.textContent ?? "").replace("The cat ran.", "").replace("The dog slept.", "");

    const flat = japaneseOnly(container.querySelector(".reader") as HTMLElement);
    fireEvent.click(toggle());
    const glossed = japaneseOnly(container.querySelector(".reader--glossed") as HTMLElement);
    expect(glossed).toBe(flat);
    expect(glossed).toBe(TEXT);
  });

  it("keeps words interactive (hover targets survive the sentence split)", () => {
    const { container } = renderReader();
    fireEvent.click(toggle());
    // 猫 and 犬 have dictionary senses and aren't saved → addable ("new").
    expect(container.querySelectorAll(".tok--new")).toHaveLength(2);
  });

  it("shows the sentence alone when its translation failed, keeping the rest aligned", () => {
    const { container } = renderReader([
      SENTENCES[0],
      { ...SENTENCES[1], gloss: null },
    ]);
    fireEvent.click(toggle());

    const pairs = container.querySelectorAll(".reader__pair");
    expect(pairs).toHaveLength(2);
    expect(pairs[1].querySelector(".reader__gloss")).toBeNull();
    expect(pairs[1].textContent).toContain("犬が寝た。"); // source still readable
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
