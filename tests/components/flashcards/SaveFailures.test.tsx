// @vitest-environment jsdom
// The done screen's note for grades whose writes failed — shared by both flashcard
// quizzes. Nothing when all saved; otherwise the count, the error, and a retry button.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SaveFailures } from "@/components/flashcards/SaveFailures";
import { LocaleProvider } from "@/i18n";

describe("SaveFailures", () => {
  it("renders nothing when every grade was saved", () => {
    render(
      <LocaleProvider>
        <SaveFailures count={0} error={null} onRetry={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says how many failed and re-sends them on retry", () => {
    const onRetry = vi.fn();
    render(
      <LocaleProvider>
        <SaveFailures count={2} error="network down" onRetry={onRetry} />
      </LocaleProvider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("2");
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
