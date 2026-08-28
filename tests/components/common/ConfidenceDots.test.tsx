// @vitest-environment jsdom
// The confidence dots as a "Forgot" control.
//
// What's pinned here is the part a later edit could quietly undo: the dots must stay
// INERT below the soften floor (the server no-ops there, so a control that does
// nothing would be worse than none), only ONE overlay may be open across the whole
// screen, and a click anywhere else must close it. The last two are enforced by a
// module-level singleton rather than per-list state, which is exactly the kind of
// thing a well-meaning refactor to useState would break without failing anything else.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ConfidenceDots } from "@/components/common/ConfidenceDots";
import { SOFTEN_MIN_CONFIDENCE } from "@/services/review";

afterEach(cleanup);

const trigger = () => screen.getAllByRole("button", { name: /press to say you forgot/i });
const popups = () => screen.queryAllByRole("button", { name: /^Forgot\?$/ });

function renderDots(props: Array<{ rating: number; onForgot?: () => Promise<void> }>) {
  return render(
    <LocaleProvider>
      <div data-testid="elsewhere">
        {props.map((p, i) => (
          <ConfidenceDots key={i} {...p} />
        ))}
      </div>
    </LocaleProvider>,
  );
}

describe("ConfidenceDots — the dots as a Forgot trigger", () => {
  it("stays inert text below the soften floor, where the server would no-op anyway", () => {
    renderDots([{ rating: SOFTEN_MIN_CONFIDENCE - 1, onForgot: async () => {} }]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays inert text when no handler is supplied", () => {
    renderDots([{ rating: 5 }]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens a Forgot? overlay on press and fires the handler when it is confirmed", async () => {
    const onForgot = vi.fn(async () => {});
    renderDots([{ rating: 4, onForgot }]);

    expect(popups()).toHaveLength(0); // pressing the dots is the whole affordance
    fireEvent.click(trigger()[0]);
    expect(popups()).toHaveLength(1);

    fireEvent.click(popups()[0]);
    await waitFor(() => expect(onForgot).toHaveBeenCalledTimes(1));
    // The overlay closing IS the acknowledgement.
    await waitFor(() => expect(popups()).toHaveLength(0));
  });

  it("keeps at most ONE overlay on screen — opening a second closes the first", () => {
    renderDots([
      { rating: 4, onForgot: async () => {} },
      { rating: 5, onForgot: async () => {} },
    ]);
    fireEvent.click(trigger()[0]);
    fireEvent.click(trigger()[1]);
    expect(popups()).toHaveLength(1);
  });

  it("closes when a press lands anywhere else", () => {
    renderDots([{ rating: 4, onForgot: async () => {} }]);
    fireEvent.click(trigger()[0]);
    expect(popups()).toHaveLength(1);

    fireEvent.pointerDown(screen.getByTestId("elsewhere"));
    expect(popups()).toHaveLength(0);
  });

  it("re-arms after a dismissal — the singleton must not stay latched", () => {
    renderDots([{ rating: 4, onForgot: async () => {} }]);
    fireEvent.click(trigger()[0]);
    fireEvent.pointerDown(document.body);
    fireEvent.click(trigger()[0]);
    expect(popups()).toHaveLength(1);
  });
});
