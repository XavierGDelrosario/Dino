// @vitest-environment jsdom
// The shared list-shaped word row (Lists, the article table, the quiz recap). Pins the
// skeleton every surface now inherits, so one surface can't quietly drift again.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

vi.mock("@/services/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/voice")>()),
  isVoiceAvailable: () => Promise.resolve(true),
  speak: () => Promise.resolve(),
  cancelSpeech: () => {},
}));

import { WordRow } from "@/components/common/WordRow";
import { splitMeanings } from "@/lib/meanings";

const word = {
  input: "猫",
  inputReading: "ねこ",
  translation: "cat; feline;  ; puss",
  translationReading: null,
  sourceLang: "JA" as const,
  targetLang: "EN" as const,
};

const renderRow = (props: Partial<Parameters<typeof WordRow>[0]> = {}) =>
  render(
    <LocaleProvider>
      <ul>
        <WordRow word={word} {...props} />
      </ul>
    </LocaleProvider>,
  );

afterEach(cleanup);

describe("splitMeanings", () => {
  it("splits on ; and drops blanks", () => {
    expect(splitMeanings("cat; feline;  ; puss")).toEqual(["cat", "feline", "puss"]);
  });
});

describe("WordRow", () => {
  it("draws the headword + reading, one line per meaning, and listen in the foot", async () => {
    const { container } = renderRow({ meta: <button>act</button> });
    expect(container.querySelector(".listrow__head")?.firstChild?.textContent).toBe("猫");
    expect(container.querySelector(".listrow__reading")?.textContent).toBe("ねこ");
    expect(
      [...container.querySelectorAll(".listrow__meaning-line")].map((l) => l.textContent),
    ).toEqual(["cat", "feline", "puss"]);
    expect(container.querySelector(".listrow__meta")?.textContent).toBe("act");
    const listen = await screen.findByRole("button", { name: "Listen" });
    expect(container.querySelector(".listrow__foot")!.contains(listen)).toBe(true);
  });

  it("lets a caller override the headword, hide the reading, and replace the meaning", () => {
    const { container } = renderRow({
      headword: "ねこ",
      reading: null,
      meaning: <span className="custom">editing</span>,
    });
    expect(container.querySelector(".listrow__head")?.textContent).toBe("ねこ");
    expect(container.querySelector(".listrow__meaning")).toBeNull();
    expect(container.querySelector(".listrow__foot .custom")).toBeTruthy();
  });

  it("omits the meta cluster when there is none", () => {
    const { container } = renderRow();
    expect(container.querySelector(".listrow__meta")).toBeNull();
  });
});
