// @vitest-environment jsdom
// Google's badge on the reader's sentence translations. An article's reading mode has
// no output box, so each translation carries the badge itself (`glossCredit`); the
// Translate tab leaves it off, because its output box shows the same translation with
// the badge once.
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

const reader = (glossCredit: boolean) =>
  render(
    <LocaleProvider>
      <ParagraphReader
        text={TEXT}
        tokens={TOKENS}
        meaningsByWord={MEANINGS}
        sentences={SENTENCES}
        glossCredit={glossCredit}
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
  it("with glossCredit, every shown translation carries one, linked to Google Translate", () => {
    reader(true);
    expect(badges()).toHaveLength(0); // nothing translated on screen yet

    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(badges()).toHaveLength(2);
    expect(badges()[0].getAttribute("href")).toBe("https://translate.google.com");
    expect(badges()[0].closest(".reader__gloss")?.textContent).toContain("The cat ran.");
  });

  it("without it (the Translate tab), the reader shows none", () => {
    reader(false);
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    expect(screen.getByText("The cat ran.")).toBeTruthy();
    expect(badges()).toHaveLength(0);
  });

  it("the badge is Google's own artwork in all three official variants", () => {
    const { container } = reader(true);
    fireEvent.click(screen.getByRole("button", { name: /Show translation/ }));
    const srcs = [...container.querySelectorAll(".gbadge img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.includes("greyscale"))).toBe(true); // light theme, repeated
    expect(srcs.some((s) => s.includes("white"))).toBe(true); // dark theme
  });
});
