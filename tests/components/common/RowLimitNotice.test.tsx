// @vitest-environment jsdom
// The account prompt: a guest who hits the word cap is offered an account (and the
// link goes to sign-up); an account holder is told the ceiling, with no sign-up link;
// dismiss hides it until the next refused save.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { RouterProvider } from "@/router";
import { RowLimitNotice } from "@/components/common/RowLimitNotice";
import { notifyRowLimit } from "@/services/rowLimit";

afterEach(cleanup);

const renderIt = (isAnonymous: boolean) =>
  render(
    <RouterProvider>
      <LocaleProvider>
        <RowLimitNotice userId="u1" isAnonymous={isAnonymous} />
      </LocaleProvider>
    </RouterProvider>,
  );

describe("RowLimitNotice", () => {
  it("renders nothing until a cap is hit", () => {
    const { container } = renderIt(true);
    expect(container.textContent).toBe("");
  });

  it("offers a guest an account, linking to sign-up", () => {
    renderIt(true);
    act(() => notifyRowLimit({ table: "user_words", max: 1000 }));
    expect(screen.getByRole("status").textContent).toMatch(/1,000 words/);
    expect(screen.getByRole("link", { name: /create account/i }).getAttribute("href")).toBe("/signup");
  });

  it("tells an account holder the ceiling, with no sign-up link", () => {
    renderIt(false);
    act(() => notifyRowLimit({ table: "user_words", max: 20000 }));
    expect(screen.getByRole("status").textContent).toMatch(/20,000 saved words/);
    expect(screen.queryByRole("link", { name: /create account/i })).toBeNull();
  });

  it("dismisses, and comes back on the next refused save", () => {
    renderIt(true);
    act(() => notifyRowLimit({ table: "lists", max: 100 }));
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => notifyRowLimit({ table: "lists", max: 100 }));
    expect(screen.getByRole("status").textContent).toMatch(/100 lists/);
  });
});
