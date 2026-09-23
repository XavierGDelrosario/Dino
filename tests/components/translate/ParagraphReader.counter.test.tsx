// @vitest-environment jsdom
// A merged number + counter in the reader (三キロ, 三本) — quality report #31.
//
// The analyzer merges the number into the counter so the whole span carries one ruby
// (さんぼん, not さん + ほん). That merge stays. What's pinned is the CARD: its meanings
// are the counter's, so its headword must be the counter too — titling "kilo-; 1000" as
// 三キロ told the learner that 三キロ is a word meaning "kilo".
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";

const TEXT = "三キロ走った。";
const TOKENS: AnalyzedToken[] = [
  { text: "三キロ", start: 0, end: 3, reading: "さんきろ", lemma: "キロ", pos: "名詞", composite: true },
  { text: "走っ", start: 3, end: 5, reading: "はしっ", lemma: "走る", pos: "動詞" },
];
const MEANINGS = new Map([
  ["キロ", [makeWord({ wordId: "w-kiro", input: "キロ", translation: "kilo-; 1000" })]],
  ["走る", [makeWord({ wordId: "w-hashiru", input: "走る", translation: "to run" })]],
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

afterEach(cleanup);

describe("ParagraphReader — number + counter", () => {
  it("keeps the whole span as one word in the text", () => {
    renderReader();
    expect(screen.getByText("三キロ")).toBeTruthy();
  });

  it("heads the card with the COUNTER, whose meanings it shows", () => {
    const { container } = renderReader();
    fireEvent.mouseEnter(screen.getByText("三キロ"));
    const head = container.querySelector(".hovercard__word") as HTMLElement;
    expect(head).toBeTruthy();
    expect(within(head).getByText("キロ")).toBeTruthy();
    expect(head.textContent).not.toContain("三");
    expect(head.textContent).not.toContain("さんきろ");
  });

  it("an ordinary word's card still heads with the word as written", () => {
    const { container } = renderReader();
    fireEvent.mouseEnter(screen.getByText("走っ"));
    const head = container.querySelector(".hovercard__word") as HTMLElement;
    expect(head.textContent).toContain("走っ");
  });
});
