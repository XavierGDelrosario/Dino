// @vitest-environment jsdom
// The pad covers the input box, so it shows what has been written so far itself — in
// place of the "Draw a character" hint, kept scrolled to its newest character.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const recognize = vi.hoisted(() => vi.fn());
vi.mock("@/services/handwriting", () => ({ recognizeHandwriting: recognize }));

import { HandwritingCanvas } from "@/components/translate/HandwritingCanvas";

beforeEach(() => {
  recognize.mockReset();
  // jsdom has no canvas; the component already tolerates a null context.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(cleanup);

function pad(onPick = vi.fn()) {
  const view = render(
    <LocaleProvider>
      <HandwritingCanvas lang="JA" onPick={onPick} onClose={vi.fn()} />
    </LocaleProvider>,
  );
  const canvas = view.container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  return { ...view, canvas, onPick };
}
async function write(canvas: HTMLCanvasElement, char: string) {
  recognize.mockResolvedValueOnce([{ text: char }]);
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 40 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(await screen.findByRole("button", { name: char }));
}

describe("HandwritingCanvas — what has been written", () => {
  it("shows the hint until something is confirmed", () => {
    pad();
    expect(screen.getByText("Draw a character")).toBeTruthy();
  });

  it("replaces the hint with the confirmed characters, in order", async () => {
    const { canvas, onPick } = pad();
    await write(canvas, "日");
    await write(canvas, "本");
    const written = screen.getByLabelText("Written so far");
    expect(written.textContent).toBe("日本");
    expect(screen.queryByText("Draw a character")).toBeNull();
    expect(onPick.mock.calls.map((c) => c[0])).toEqual(["日", "本"]);
  });

  it("keeps the newest character in view", async () => {
    const { canvas } = pad();
    await write(canvas, "日");
    const written = screen.getByLabelText("Written so far");
    Object.defineProperty(written, "scrollWidth", { value: 900, configurable: true });
    await write(canvas, "本");
    await waitFor(() => expect(written.scrollLeft).toBe(900));
  });

  it("cancels touches on the pad, so iOS can't start its long-press loupe", () => {
    const { canvas } = pad();
    const e = new Event("touchstart", { cancelable: true, bubbles: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
