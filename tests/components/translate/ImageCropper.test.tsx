// @vitest-environment jsdom
// The cropper's non-canvas behaviour. jsdom implements no 2D context (and returns a
// zero-size getBoundingClientRect), so the actual pixel crop and the drag maths are
// covered by services/ocr/crop.test.ts instead — what matters here is the CONTRACT
// with the caller: cancelling recognizes nothing, and an untouched selection hands
// back null meaning "use the original photo, don't re-encode it".
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ImageCropper } from "@/components/translate/ImageCropper";

const SRC = "data:image/jpeg;base64,AAAA";

function setup(props: Partial<Parameters<typeof ImageCropper>[0]> = {}) {
  const onCancel = vi.fn();
  const onCrop = vi.fn();
  const r = render(
    <LocaleProvider>
      <ImageCropper src={SRC} onCancel={onCancel} onCrop={onCrop} {...props} />
    </LocaleProvider>,
  );
  const button = (name: RegExp) =>
    [...r.container.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
  return { onCancel, onCrop, button, container: r.container };
}

describe("ImageCropper", () => {
  afterEach(cleanup);

  it("shows the captured photo", () => {
    const { container } = setup();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(SRC);
  });

  it("cancel recognizes nothing", () => {
    const { onCancel, onCrop, button } = setup();
    fireEvent.click(button(/Cancel/i));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCrop).not.toHaveBeenCalled();
  });

  it("confirming an UNTOUCHED selection sends null — the original bytes, not a re-encode", () => {
    const { onCrop, button } = setup();
    fireEvent.click(button(/Recognize/i));
    expect(onCrop).toHaveBeenCalledWith(null);
  });

  it("locks both buttons while recognition is in flight", () => {
    const { onCrop, onCancel, button } = setup({ busy: true });
    fireEvent.click(button(/Cancel/i));
    fireEvent.click(button(/…/));
    expect(onCrop).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
