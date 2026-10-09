// @vitest-environment jsdom
// The page/section loader: the mascot + dots (the splash in miniature), an optional
// message without a doubled ellipsis, and the footer hidden while it is up — an empty
// page used to show nothing but "Privacy · Terms · Support".
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PageLoading } from "@/components/common/Loading";

afterEach(cleanup);

describe("PageLoading", () => {
  it("shows the mascot and the dots, and hides the footer", () => {
    const { container } = render(<PageLoading />);
    expect(container.querySelector("img.pageloading__icon")?.getAttribute("src")).toBe("/dino-icon.png");
    expect(container.querySelector(".loading-dots")).not.toBeNull();
    expect(container.querySelector("[data-no-footer]")).not.toBeNull();
  });
  it("shows a message without its static ellipsis", () => {
    const { container, getByRole } = render(<PageLoading text="Loading words…" />);
    expect(container.querySelector(".pageloading__text")?.textContent).toBe("Loading words");
    expect(getByRole("status").getAttribute("aria-label")).toBe("Loading words");
  });
  it("has a compact inline variant for a loader inside a section", () => {
    const { container } = render(<PageLoading inline />);
    expect(container.querySelector(".pageloading--inline")).not.toBeNull();
  });
});
