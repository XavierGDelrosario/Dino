// @vitest-environment jsdom
// Where a list row puts its controls. The row has two clusters and the difference is
// deliberate: the HEADER carries the actions that change the word (info, edit, tag,
// delete), while the listen button sits bottom-RIGHT with the meaning, so "play this"
// doesn't read as one more thing that edits the row. Pinned here because it's layout
// intent that an unrelated edit could quietly undo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeUserWord } from "@test/fixtures";

vi.mock("@/services/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/voice")>()),
  isVoiceAvailable: () => Promise.resolve(true),
  speak: () => Promise.resolve(),
  cancelSpeech: () => {},
}));

import { ListRow } from "@/components/lists/ListRow";

const word = makeUserWord({
  input: "猫",
  inputReading: "ねこ",
  translation: "cat; feline",
  sourceLang: "JA",
});

function renderRow(onEdit = vi.fn()) {
  return render(
    <LocaleProvider>
      <ul>
        <ListRow
          word={word}
          lists={[]}
          onEdit={onEdit}
          onDelete={vi.fn()}
          onTag={vi.fn()}
          onCreateList={vi.fn().mockResolvedValue(undefined)}
        />
      </ul>
    </LocaleProvider>,
  );
}

const speakBtn = () => screen.queryByRole("button", { name: "Listen" });
const startEditing = () => fireEvent.click(screen.getByRole("button", { name: /meaning/i }));

describe("ListRow — control placement", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("puts the listen button in the bottom row, not the header actions", async () => {
    const { container } = renderRow();
    await waitFor(() => expect(speakBtn()).toBeTruthy()); // voice availability is async
    expect(container.querySelector(".listrow__foot")!.contains(speakBtn())).toBe(true);
    expect(container.querySelector(".listrow__meta")!.contains(speakBtn())).toBe(false);
  });

  it("keeps it in place while the meaning is being edited", async () => {
    const { container } = renderRow();
    await waitFor(() => expect(speakBtn()).toBeTruthy());
    startEditing();
    expect(container.querySelector(".listrow__editing")).toBeTruthy(); // now editing
    expect(container.querySelector(".listrow__foot")!.contains(speakBtn())).toBe(true);
  });
});

describe("ListRow — editing the meaning", () => {
  afterEach(cleanup);

  it("edits in a TEXTAREA, so a long multi-sense meaning is readable, not clipped", () => {
    renderRow();
    startEditing();
    const field = screen.getByRole("textbox", { name: /meaning/i });
    expect(field.tagName).toBe("TEXTAREA");
    expect((field as HTMLTextAreaElement).value).toBe("cat; feline");
  });

  it("collapses the newlines the textarea allows — a meaning is stored on one line", () => {
    const onEdit = vi.fn();
    renderRow(onEdit);
    startEditing();
    fireEvent.change(screen.getByRole("textbox", { name: /meaning/i }), {
      target: { value: "nightclub;\n club (weapon)\n" },
    });
    fireEvent.click(screen.getByTitle("Save"));
    expect(onEdit).toHaveBeenCalledWith("nightclub; club (weapon)");
  });

  it("does not save an empty meaning", () => {
    const onEdit = vi.fn();
    renderRow(onEdit);
    startEditing();
    fireEvent.change(screen.getByRole("textbox", { name: /meaning/i }), {
      target: { value: "   \n  " },
    });
    fireEvent.click(screen.getByTitle("Save"));
    expect(onEdit).not.toHaveBeenCalled();
  });
});
