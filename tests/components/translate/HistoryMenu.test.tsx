// @vitest-environment jsdom
// Clear erases up to 200 lookups kept across restarts, with no undo — so it asks first.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { HistoryMenu } from "@/components/translate/HistoryMenu";
import type { TranslateHistoryEntry } from "@/services/translateHistory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ENTRIES = [{ text: "猫", source: "JA", target: "EN" }] as TranslateHistoryEntry[];

function menu(answer: boolean) {
  const confirmSpy = vi.fn((_message?: string) => answer);
  vi.stubGlobal("confirm", confirmSpy);
  const onClear = vi.fn();
  const onClose = vi.fn();
  render(
    <LocaleProvider>
      <HistoryMenu entries={ENTRIES} open onToggle={vi.fn()} onClose={onClose} onPick={vi.fn()} onClear={onClear} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Clear the translation history/ }));
  return { confirmSpy, onClear, onClose };
}

describe("HistoryMenu — Clear", () => {
  it("asks first, and clears on yes", () => {
    const { confirmSpy, onClear, onClose } = menu(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/can't be undone/);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing on no — the history and the menu both stay", () => {
    const { onClear, onClose } = menu(false);
    expect(onClear).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("HistoryMenu — dates", () => {
  const open = (entries: TranslateHistoryEntry[]) =>
    render(
      <LocaleProvider>
        <HistoryMenu entries={entries} open onToggle={vi.fn()} onClose={vi.fn()} onPick={vi.fn()} onClear={vi.fn()} />
      </LocaleProvider>,
    );

  it("prints the day beside the direction", () => {
    const at = new Date(new Date().getFullYear(), 9, 6, 12).getTime(); // Oct 6, this year
    const { container } = open([{ text: "猫", source: "JA", target: "EN", at }] as TranslateHistoryEntry[]);
    expect(container.querySelector(".thistory__dir")?.textContent).toMatch(/JA → EN · .*6/);
  });

  it("an entry kept before dates were stored shows the direction alone", () => {
    const { container } = open(ENTRIES);
    expect(container.querySelector(".thistory__dir")?.textContent?.trim()).toBe("JA → EN");
  });
});
