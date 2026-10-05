// @vitest-environment jsdom
// A person's or company's name is not vocabulary, but the reader still shows it: it is
// highlighted, and its card carries the reading, a "Name" tag and a ＋.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ParagraphReader } from "@/components/translate/ParagraphReader";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";

afterEach(cleanup);

const TEXT = "田中は猫を見た";
const TOKENS = [
  { text: "田中", start: 0, end: 2, reading: "たなか", lemma: "田中", pos: "人名", nameKind: "person" },
  { text: "猫", start: 3, end: 4, reading: "ねこ", lemma: "猫", pos: "名詞" },
] as AnalyzedToken[];
const NAME = makeWord({ wordId: "name:JA:田中", input: "田中", inputReading: "たなか", translation: "Tanaka" });
const MEANINGS = new Map([
  ["田中", [NAME]],
  ["猫", [makeWord({ wordId: "w-neko", input: "猫", translation: "cat" })]],
]);

const reader = (names: ReadonlySet<string> | undefined, onAdd = vi.fn(async () => {})) => {
  const view = render(
    <LocaleProvider>
      <ParagraphReader
        text={TEXT}
        tokens={TOKENS}
        meaningsByWord={MEANINGS}
        names={names}
        saved={new Set()}
        confidence={new Map()}
        lists={[]}
        onAdd={onAdd}
        onCreateList={async () => "list-1"}
      />
    </LocaleProvider>,
  );
  return { ...view, onAdd };
};
const token = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLElement>(".tok")].find((el) => el.textContent === text)!;

describe("ParagraphReader — names", () => {
  it("a flagged name is highlighted like a new word", () => {
    const { container } = reader(new Set(["田中"]));
    expect(token(container, "田中").className).toContain("tok--new");
  });

  it("without the flag, a non-content token stays plain text", () => {
    const { container } = reader(undefined);
    expect(token(container, "田中").className).toContain("tok--plain");
  });

  it("its card shows the romanization and a Name tag, not a level", () => {
    const { container } = reader(new Set(["田中"]));
    fireEvent.mouseEnter(token(container, "田中"));
    expect(screen.getByText("Tanaka")).toBeTruthy();
    expect(screen.getByText("Name")).toBeTruthy();
  });

  it("an ordinary word's card has no Name tag", () => {
    const { container } = reader(new Set(["田中"]));
    fireEvent.mouseEnter(token(container, "猫"));
    expect(screen.getByText("cat")).toBeTruthy();
    expect(screen.queryByText("Name")).toBeNull();
  });
});
