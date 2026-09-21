// @vitest-environment jsdom
// Tapping a word a SECOND time puts its card away.
//
// The card opens on mouseenter, and a touch tap synthesizes that — touchstart →
// pointerdown → mouseover → … → click. So the whole risk this file guards is a close
// that fires on the tap which OPENED the card: the reader latches "was it already
// open" at pointerdown, the one moment still ahead of the synthetic hover, and these
// cases replay both orders literally.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";

const TEXT = "猫と犬。";
const TOKENS: AnalyzedToken[] = [
  { text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: "名詞" },
  { text: "犬", start: 2, end: 3, reading: "いぬ", lemma: "犬", pos: "名詞" },
];
const MEANINGS = new Map([
  ["猫", [makeWord({ wordId: "w-neko", input: "猫", translation: "cat" })]],
  ["犬", [makeWord({ wordId: "w-inu", input: "犬", translation: "dog" })]],
]);

function renderReader() {
  return render(
    <LocaleProvider>
      <ParagraphReader
        text={TEXT}
        tokens={TOKENS}
        meaningsByWord={MEANINGS}
        saved={new Set()}
        confidence={new Map()}
        lists={[]}
        onAdd={async () => {}}
        onCreateList={async () => "list-1"}
      />
    </LocaleProvider>,
  );
}

const tok = (word: string) => screen.getAllByText(word)[0];
/** One touch tap, in the order a touch browser delivers it. */
const tap = (word: string) => {
  const el = tok(word);
  fireEvent.pointerDown(el);
  fireEvent.mouseEnter(el);
  fireEvent.click(el);
};
/** The card is identified by the meaning it prints, which the paragraph never does. */
const card = (meaning: string) => screen.queryByText(meaning);

afterEach(cleanup);

describe("ParagraphReader — tap the same word to close", () => {
  it("opens on the first tap and stays open", () => {
    renderReader();
    tap("猫");
    expect(card("cat")).not.toBeNull();
  });

  it("closes on the second tap of the same word", () => {
    renderReader();
    tap("猫");
    tap("猫");
    expect(card("cat")).toBeNull();
  });

  it("re-opens on the third tap, even if the browser stops re-firing mouseenter", () => {
    renderReader();
    tap("猫");
    tap("猫");
    // Already "hovered" as far as the browser is concerned, so no mouseenter this
    // time — the click alone has to bring the card back.
    const el = tok("猫");
    fireEvent.pointerDown(el);
    fireEvent.click(el);
    expect(card("cat")).not.toBeNull();
  });

  it("tapping a DIFFERENT word switches the card rather than closing it", () => {
    renderReader();
    tap("猫");
    tap("犬");
    expect(card("cat")).toBeNull();
    expect(card("dog")).not.toBeNull();
  });

  it("a mouse click on the word the pointer is already hovering closes it", () => {
    renderReader();
    const el = tok("猫");
    fireEvent.mouseEnter(el); // hover alone opens the card
    expect(card("cat")).not.toBeNull();
    fireEvent.pointerDown(el);
    fireEvent.click(el);
    expect(card("cat")).toBeNull();
  });
});
