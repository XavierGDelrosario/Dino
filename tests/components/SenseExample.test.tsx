// @vitest-environment jsdom
// The example-sentence disclosure, on the two surfaces that share it.
//
// The behaviours pinned here are the ones an unrelated edit could quietly undo: the
// affordance must be ABSENT (not disabled) for the many senses nobody has written up
// yet, the sentence must stay hidden until asked for, and opening it must not also
// select the row it lives in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeUserWord } from "@test/fixtures";

vi.mock("@/services/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/voice")>()),
  isVoiceAvailable: () => Promise.resolve(true),
  speak: () => Promise.resolve(),
  cancelSpeech: () => {},
}));

import { SenseExample } from "@/components/common/SenseExample";
import { ListRow } from "@/components/lists/ListRow";

const ENRICHED = {
  example: "このいちごはとても甘い。",
  exampleGloss: "These strawberries are very sweet.",
  definitionJa: "砂糖や蜜のような味である。",
};

const renderEx = (props: Partial<typeof ENRICHED> = {}) =>
  render(
    <LocaleProvider>
      <SenseExample example={null} exampleGloss={null} definitionJa={null} {...props} />
    </LocaleProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SenseExample", () => {
  it("renders nothing at all for a sense with no example and no definition", () => {
    const { container } = renderEx();
    // Absent, not disabled: most senses are unwritten while the corpus is authored in
    // batches, and a dead button on every row would read as a broken feature.
    expect(container.innerHTML).toBe("");
  });

  it("still offers the panel when only a definition exists (no example yet)", () => {
    renderEx({ definitionJa: "砂糖や蜜のような味である。" });
    expect(screen.getByRole("button", { name: /example/i })).toBeTruthy();
  });

  it("keeps the sentence hidden until the toggle is pressed", () => {
    renderEx(ENRICHED);
    expect(screen.queryByText(ENRICHED.example)).toBeNull();

    const toggle = screen.getByRole("button", { name: /example/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByText(ENRICHED.example)).toBeTruthy();
    expect(screen.getByText(ENRICHED.exampleGloss)).toBeTruthy();
    expect(screen.getByText(ENRICHED.definitionJa)).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide example/i }).getAttribute("aria-expanded")).toBe("true");
  });

  it("closes again on a second press", () => {
    renderEx(ENRICHED);
    fireEvent.click(screen.getByRole("button", { name: /example/i }));
    fireEvent.click(screen.getByRole("button", { name: /hide example/i }));
    expect(screen.queryByText(ENRICHED.example)).toBeNull();
  });
});

describe("SenseExample — inside a Lists row", () => {
  const renderRow = (word = makeUserWord({ ...ENRICHED, input: "甘い", translation: "sweet" }), extra = {}) =>
    render(
      <LocaleProvider>
        <ul>
          <ListRow
            word={word}
            lists={[]}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onTag={vi.fn()}
            onCreateList={vi.fn().mockResolvedValue("l1")}
            {...extra}
          />
        </ul>
      </LocaleProvider>,
    );

  it("puts the example toggle in the bottom strip, before the listen button", async () => {
    renderRow();
    const foot = document.querySelector(".listrow__foot")!;
    const buttons = [...foot.querySelectorAll("button")];
    const example = buttons.findIndex((b) => b.classList.contains("senseex__toggle"));
    const speak = buttons.findIndex((b) => b.classList.contains("speakbtn"));
    expect(example).toBeGreaterThanOrEqual(0);
    // The speak button mounts asynchronously (voice availability is a promise); when
    // it is there, the example must precede it — "to the LEFT of the speaker".
    if (speak >= 0) expect(example).toBeLessThan(speak);
  });

  it("opening the example does not also select the row in select mode", () => {
    const onToggleSelect = vi.fn();
    renderRow(makeUserWord({ ...ENRICHED, input: "甘い" }), { selectable: true, onToggleSelect });

    fireEvent.click(screen.getByRole("button", { name: /example/i }));
    expect(screen.getByText(ENRICHED.example)).toBeTruthy();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("shows no toggle for a saved word whose sense has no example", () => {
    renderRow(makeUserWord({ input: "猫", translation: "cat" }));
    expect(screen.queryByRole("button", { name: /example/i })).toBeNull();
  });
});
