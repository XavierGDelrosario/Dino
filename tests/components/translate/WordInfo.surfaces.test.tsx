// @vitest-environment jsdom
// The word-info "?" (Level · Commonness · Part of speech) on the two surfaces that
// lacked it: the Translate result head and the reader's hover card. Every other word
// surface (Lists, flashcards, the article table) already carried it.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { WordResults } from "@/components/translate/WordResults";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";

afterEach(cleanup);

// 猫 as an N5 noun (band 1 = N5 on the JLPT scale).
const NEKO = makeWord({ wordId: "w1", input: "猫", translation: "cat", sourceLang: "JA", proficiencyBand: 1, partOfSpeech: ["n"] });
const SHAMISEN = makeWord({ wordId: "w2", input: "猫", translation: "shamisen", sourceLang: "JA" });
const info = () => screen.queryAllByRole("button", { name: /word details/i });

describe("word info on the Translate result", () => {
  it("the head row carries one ? whose panel shows the level", () => {
    render(
      <LocaleProvider>
        <WordResults headword="猫" meanings={[NEKO, SHAMISEN]} saved={new Set()} confidence={new Map()}
          lists={[]} userId="u" onAdd={async () => {}} onCreateList={async () => "l"} />
      </LocaleProvider>,
    );
    expect(info()).toHaveLength(1); // the head only — not once per sense
    const panel = info()[0].parentElement!.querySelector(".wordinfo-panel") as HTMLElement;
    expect(within(panel).getByText(/N5/)).toBeTruthy();
  });
});

describe("word info in the reader's hover card", () => {
  it("appears beside the hovered headword", () => {
    render(
      <LocaleProvider>
        <ParagraphReader text="猫。" tokens={[{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: "名詞" }]}
          meaningsByWord={new Map([["猫", [NEKO, SHAMISEN]]])} saved={new Set()} confidence={new Map()}
          lists={[]} onAdd={async () => {}} onCreateList={async () => "l"} />
      </LocaleProvider>,
    );
    expect(info()).toHaveLength(0);
    fireEvent.mouseEnter(screen.getByText("猫"));
    expect(info()).toHaveLength(1);
  });
});
