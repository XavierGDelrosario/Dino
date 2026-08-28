// @vitest-environment jsdom
// The word popup's "Forgot" button — one notch down for a word the colouring claims
// you know.
//
// What's pinned here is everything a later edit could quietly undo, in the order it
// matters: the button must be ABSENT (not disabled) where there is nothing to lower,
// and a double-tap must not cost two notches. The second is the whole reason the
// button holds itself spent after a press — on a touch surface the same intent
// arrives twice routinely, and this control is destructive-ish.
//
// The SERVER is the other half of that guarantee (migration 20260766 refuses a second
// drop within 2s and below 3/5); this file is only about the view keeping its side.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";
import type { Word } from "@/services/words/repository";

const TEXT = "猫と犬。";
const TOKENS: AnalyzedToken[] = [
  { text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: "名詞" },
  { text: "犬", start: 2, end: 3, reading: "いぬ", lemma: "犬", pos: "名詞" },
];

// 猫 has TWO saved senses at different confidences; 犬 has one, low.
const NEKO_A = makeWord({ wordId: "w-neko-a", input: "猫", translation: "cat" });
const NEKO_B = makeWord({ wordId: "w-neko-b", input: "猫", translation: "shamisen" });
const INU = makeWord({ wordId: "w-inu", input: "犬", translation: "dog" });
const MEANINGS = new Map([
  ["猫", [NEKO_A, NEKO_B]],
  ["犬", [INU]],
]);

function renderReader(opts: {
  confidence: Map<string, number>;
  onForgot?: (words: Word[]) => Promise<void>;
}) {
  return render(
    <LocaleProvider>
      <ParagraphReader
        text={TEXT}
        tokens={TOKENS}
        meaningsByWord={MEANINGS}
        saved={new Set([...opts.confidence.keys()])}
        confidence={opts.confidence}
        lists={[]}
        onAdd={async () => {}}
        onCreateList={async () => "list-1"}
        onForgot={opts.onForgot}
      />
    </LocaleProvider>,
  );
}

/** Open the popup by hovering a word (the reader's own affordance). */
const hover = (word: string) => fireEvent.mouseEnter(screen.getByText(word));
const forgotBtn = () => screen.queryByRole("button", { name: /lower its confidence/i });

beforeEach(() => vi.useRealTimers());
afterEach(cleanup);

describe("ParagraphReader — Forgot", () => {
  it("is absent for a word below the floor: there is nothing left to lower", () => {
    renderReader({ confidence: new Map([["w-inu", 2]]), onForgot: async () => {} });
    hover("犬");
    expect(forgotBtn()).toBeNull();
  });

  it("is absent when the surface gives no handler at all", () => {
    renderReader({ confidence: new Map([["w-neko-a", 5]]) });
    hover("猫");
    expect(forgotBtn()).toBeNull();
  });

  it("appears at the floor and hands back only the senses that can move", async () => {
    const onForgot = vi.fn(async (_words: Word[]) => {});
    // Sense A is at the floor exactly (3); sense B is below it (1) and must be left
    // alone — softening it would be a drop the button never offered.
    renderReader({
      confidence: new Map([
        ["w-neko-a", 3],
        ["w-neko-b", 1],
      ]),
      onForgot,
    });
    hover("猫");

    const btn = forgotBtn();
    expect(btn).toBeTruthy();
    await act(async () => {
      fireEvent.click(btn!);
    });

    expect(onForgot).toHaveBeenCalledTimes(1);
    expect(onForgot.mock.calls[0][0]).toEqual([expect.objectContaining({ wordId: "w-neko-a" })]);
  });

  it("costs ONE notch on a double-tap — the second press is refused, not queued", async () => {
    const onForgot = vi.fn(async (_words: Word[]) => {});
    renderReader({ confidence: new Map([["w-neko-a", 5]]), onForgot });
    hover("猫");

    const btn = forgotBtn()!;
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn); // the fat-fingered second half of the same intent
    });

    expect(onForgot).toHaveBeenCalledTimes(1);
    // Still on screen, visibly spent: it must not vanish under a finger that may
    // still be coming down.
    expect(forgotBtn()).toBeTruthy();
    expect(forgotBtn()).toHaveProperty("disabled", true);
  });

  it("re-arms after the hold, so a deliberate second notch is still possible", async () => {
    vi.useFakeTimers();
    const onForgot = vi.fn(async (_words: Word[]) => {});
    renderReader({ confidence: new Map([["w-neko-a", 5]]), onForgot });
    hover("猫");

    await act(async () => {
      fireEvent.click(forgotBtn()!);
    });
    expect(forgotBtn()).toHaveProperty("disabled", true);

    // Long enough to cover the hold (2.5s) — and, by construction, the server's own
    // 2s dedupe window, so the re-armed press is one the server will honour.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(forgotBtn()).toHaveProperty("disabled", false);

    await act(async () => {
      fireEvent.click(forgotBtn()!);
    });
    expect(onForgot).toHaveBeenCalledTimes(2);
  });

  it("does not carry a spent button over to the next word hovered", async () => {
    const onForgot = vi.fn(async (_words: Word[]) => {});
    renderReader({
      confidence: new Map([
        ["w-neko-a", 5],
        ["w-inu", 4],
      ]),
      onForgot,
    });
    hover("猫");
    await act(async () => {
      fireEvent.click(forgotBtn()!);
    });
    expect(forgotBtn()).toHaveProperty("disabled", true);

    // A different word is a different question: 犬 is armed even though 猫 is spent.
    await act(async () => {
      hover("犬");
    });
    expect(forgotBtn()).toHaveProperty("disabled", false);
  });
});
