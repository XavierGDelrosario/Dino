// Crop-rectangle maths. This is the whole reason the geometry is a pure module: the
// cropper itself only exists behind a native camera, so dragging it by hand means an
// iOS build and a real photo. The failure modes are all "drag past an edge" cases —
// an inverted box, a box hanging off the picture, a 0×0 crop that makes drawImage
// throw — so they're pinned here instead.
import { describe, it, expect } from "vitest";
import {
  clampRect,
  moveRect,
  resizeRect,
  toPixels,
  isFullFrame,
  DEFAULT_CROP,
  MIN_CROP,
} from "@/services/ocr/crop";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("clampRect", () => {
  it("keeps a sane rect untouched", () => {
    expect(clampRect(rect(0.1, 0.2, 0.5, 0.6))).toEqual(rect(0.1, 0.2, 0.5, 0.6));
  });

  it("pulls a rect that hangs off the right/bottom back inside", () => {
    const r = clampRect(rect(0.8, 0.9, 0.5, 0.5));
    expect(r.x + r.width).toBeCloseTo(1);
    expect(r.y + r.height).toBeCloseTo(1);
  });

  it("rejects negative origins and enforces the minimum size", () => {
    const r = clampRect(rect(-0.5, -0.2, 0.001, 0.001));
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(MIN_CROP);
    expect(r.height).toBe(MIN_CROP);
  });
});

describe("moveRect", () => {
  it("translates without resizing", () => {
    const r = moveRect(rect(0.1, 0.1, 0.4, 0.4), 0.2, 0.1);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.4);
    expect(r.height).toBeCloseTo(0.4);
  });

  it("stops at the edge instead of pushing the box off the image", () => {
    const r = moveRect(rect(0.5, 0.5, 0.4, 0.4), 0.9, 0.9);
    expect(r).toEqual(rect(0.6, 0.6, 0.4, 0.4)); // flush right/bottom, same size
  });
});

describe("resizeRect", () => {
  it("drags the SE corner, pinning the NW one", () => {
    const r = resizeRect(rect(0.2, 0.2, 0.4, 0.4), "se", 0.1, 0.1);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.5);
    expect(r.height).toBeCloseTo(0.5);
  });

  it("drags the NW corner, pinning the SE one", () => {
    const r = resizeRect(rect(0.2, 0.2, 0.4, 0.4), "nw", 0.1, 0.1);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.x + r.width).toBeCloseTo(0.6); // far edge stayed put
    expect(r.y + r.height).toBeCloseTo(0.6);
  });

  it("does not invert when a corner is dragged past its opposite edge", () => {
    const r = resizeRect(rect(0.2, 0.2, 0.4, 0.4), "nw", 0.9, 0.9);
    expect(r.width).toBeCloseTo(MIN_CROP);
    expect(r.height).toBeCloseTo(MIN_CROP);
    expect(r.width).toBeGreaterThan(0);
  });

  it("clamps a corner dragged outside the image", () => {
    const r = resizeRect(rect(0.2, 0.2, 0.4, 0.4), "se", 5, 5);
    expect(r.x + r.width).toBeCloseTo(1);
    expect(r.y + r.height).toBeCloseTo(1);
  });

  it("treats the 'move' handle as a translation", () => {
    expect(resizeRect(rect(0.1, 0.1, 0.2, 0.2), "move", 0.1, 0)).toEqual(rect(0.2, 0.1, 0.2, 0.2));
  });
});

describe("toPixels", () => {
  it("maps a normalized rect onto source pixels", () => {
    expect(toPixels(rect(0.25, 0.5, 0.5, 0.25), 4000, 3000)).toEqual({
      sx: 1000,
      sy: 1500,
      sw: 2000,
      sh: 750,
    });
  });

  it("never returns a zero-size source (drawImage throws on one)", () => {
    const p = toPixels(rect(0.999, 0.999, 0.0001, 0.0001), 100, 100);
    expect(p.sw).toBeGreaterThanOrEqual(1);
    expect(p.sh).toBeGreaterThanOrEqual(1);
  });

  it("keeps the source rect inside the image", () => {
    const p = toPixels(rect(0.9, 0.9, 0.5, 0.5), 1000, 1000);
    expect(p.sx + p.sw).toBeLessThanOrEqual(1000);
    expect(p.sy + p.sh).toBeLessThanOrEqual(1000);
  });
});

describe("isFullFrame", () => {
  it("treats the untouched default selection as the whole photo (no re-encode)", () => {
    // The default MUST be the true full frame: an inset default would silently drop
    // a border of the photo for anyone who just hits Recognize.
    expect(DEFAULT_CROP).toEqual(rect(0, 0, 1, 1));
    expect(isFullFrame(DEFAULT_CROP)).toBe(true);
  });

  it("is false once the user has actually cropped", () => {
    expect(isFullFrame(rect(0.1, 0.1, 0.5, 0.3))).toBe(false);
    expect(isFullFrame(rect(0, 0, 1, 0.5))).toBe(false); // a wide band is still a crop
  });
});
