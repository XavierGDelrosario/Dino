// @vitest-environment jsdom
// Google's badge on the reader's sentence translations: ONCE, at the bottom-right of the
// reader, whenever one of its machine translations is on screen — in every host
// (Translate, the live reader, an article's reading mode). It used to trail every
// sentence, and only in an article.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";
import type { SentenceGloss } from "@/services/lookup";

const TEXT = "猫が走った。犬が寝た。";
const TOKENS: AnalyzedToken[] = [
  { text: "猫", start: 0, end: 1, lemma: "猫", reading: "ねこ", pos: "名詞" } as AnalyzedToken,
  { text: "犬", start: 6, end: 7, lemma: "犬", reading: "いぬ", pos: "名詞" } as AnalyzedToken,
];
const SENTENCES: SentenceGloss[] = [
  { text: "猫が走った。", start: 0, end: 6, gloss: "The cat ran." },
  { text: "犬が寝た。", start: 6, end: 11, gloss: "The dog slept." },
];
const MEANINGS = new Map([["猫", [makeWord({ input: "猫", translation: "cat" })]]]);

const reader = (sentences: SentenceGloss[] = SENTENCES, text = TEXT) =>
  render(
    <LocaleProvider>
      <ParagraphReader
        text={text}
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
const badges = () => screen.queryAllByRole("link", { name: "Translated by Google" });

afterEach(cleanup);

describe("ParagraphReader — Google's badge on translations", () => {
  it("one badge at the reader's foot while translations show, none before or after", () => {
    const { container } = reader();
    expect(badges()).toHaveLength(0); // nothing translated on screen yet

    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    expect(badges()).toHaveLength(1); // two sentences, ONE badge
    expect(badges()[0].getAttribute("href")).toBe("https://translate.google.com");
    expect(badges()[0].closest(".reader__credit")).not.toBeNull();
    // Inside the reader's body, after the text — the bottom-right corner in CSS.
    expect(container.querySelector(".reader__body > .reader + .reader__credit")).not.toBeNull();
    expect(container.querySelector(".reader__gloss .gbadge")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(badges()).toHaveLength(0);
  });

  it("the unpunctuated layout (one block under the text) carries it too", () => {
    reader([{ text: "猫が走った", start: 0, end: 5, gloss: "The cat ran" }], "猫が走った");
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(screen.getByText("The cat ran")).toBeTruthy();
    expect(badges()).toHaveLength(1);
  });

  it("the badge is Google's own artwork in the official variants", () => {
    const { container } = reader();
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    const srcs = [...container.querySelectorAll(".gbadge img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.includes("greyscale"))).toBe(true); // light theme
    expect(srcs.some((s) => s.includes("white"))).toBe(true); // dark theme
  });
});
