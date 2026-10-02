// @vitest-environment jsdom
// Hover intent: while a word's card is open, ANOTHER word only takes it over if the
// pointer rests on it. The card sits beside its word (usually up/down and to the
// right), so the diagonal path from word to card crosses the neighbouring word — and
// switching on contact swapped the card out from under the pointer mid-move, which
// read as the card disappearing.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
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

const token = (word: string) => screen.getAllByText(word).find((el) => el.classList.contains("tok"))!;
const card = () => document.querySelector(".hovercard");
const cardHead = () => card()?.querySelector(".hovercard__word")?.textContent ?? null;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ParagraphReader — hover intent", () => {
  it("keeps the open card when the pointer only passes over another word on its way in", () => {
    vi.useFakeTimers();
    renderReader();
    fireEvent.mouseEnter(token("猫"));
    expect(cardHead()).toContain("猫");

    // 猫 → across 犬 → into the card, faster than the switch delay.
    fireEvent.mouseLeave(token("猫"));
    fireEvent.mouseEnter(token("犬"));
    act(() => vi.advanceTimersByTime(60));
    fireEvent.mouseLeave(token("犬"));
    fireEvent.mouseEnter(card()!);
    act(() => vi.advanceTimersByTime(1000));

    expect(cardHead()).toContain("猫");
  });

  it("switches to another word the pointer rests on", () => {
    vi.useFakeTimers();
    renderReader();
    fireEvent.mouseEnter(token("猫"));
    fireEvent.mouseLeave(token("猫"));
    fireEvent.mouseEnter(token("犬"));
    // Deciding: the old card stays up rather than blinking out.
    act(() => vi.advanceTimersByTime(100));
    expect(cardHead()).toContain("猫");
    act(() => vi.advanceTimersByTime(100));
    expect(cardHead()).toContain("犬");
  });

  it("opens immediately when no card is open", () => {
    vi.useFakeTimers();
    renderReader();
    fireEvent.mouseEnter(token("犬"));
    expect(cardHead()).toContain("犬");
  });
});
