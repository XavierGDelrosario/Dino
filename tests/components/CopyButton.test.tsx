// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { CopyButton } from "@/components/common/CopyButton";

const writeText = vi.fn(async (_t: string) => {});
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = (text: string) =>
  render(
    <LocaleProvider>
      <CopyButton text={text} />
    </LocaleProvider>,
  );

describe("CopyButton", () => {
  it("puts exactly the text on the clipboard and says so", async () => {
    button("猫が走った。");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("猫が走った。");
  });

  it("goes back to Copy after a moment", async () => {
    vi.useFakeTimers();
    button("cat");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("renders nothing when there is nothing to copy", () => {
    button("   ");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not claim success when the copy fails", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    document.execCommand = vi.fn(() => false);
    button("cat");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
