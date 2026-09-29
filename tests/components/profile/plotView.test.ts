// The History plot's zoom/pan window (plotView.ts): the data under the cursor stays put
// while zooming, the window never leaves the data, and never collapses to nothing.
import { describe, it, expect } from "vitest";
import { clampView, fullView, isFullView, niceTicks, panBy, zoomAt, type Bounds } from "@/components/profile/plotView";

const b: Bounds = { xMax: 29, yMin: 0, yMax: 5, minX: 2, minY: 0.5 };

describe("plotView", () => {
  it("starts at the whole range", () => {
    expect(fullView(b)).toEqual({ x0: 0, x1: 29, y0: 0, y1: 5 });
    expect(isFullView(fullView(b), b)).toBe(true);
  });

  it("zooms about the focus: the point under the cursor stays under it", () => {
    const v = zoomAt(fullView(b), b, 0.5, 0.25, 0.8); // cursor ¼ across, near the bottom
    expect(v.x1 - v.x0).toBeCloseTo(14.5);
    expect(v.y1 - v.y0).toBeCloseTo(2.5);
    expect(v.x0 + 0.25 * (v.x1 - v.x0)).toBeCloseTo(0.25 * 29);
    expect(v.y1 - 0.8 * (v.y1 - v.y0)).toBeCloseTo(5 - 0.8 * 5);
  });

  it("never zooms past the minimum span or out past the data", () => {
    let v = fullView(b);
    for (let i = 0; i < 30; i++) v = zoomAt(v, b, 0.5);
    expect(v.x1 - v.x0).toBeCloseTo(2);
    expect(v.y1 - v.y0).toBeCloseTo(0.5);
    for (let i = 0; i < 30; i++) v = zoomAt(v, b, 2);
    expect(isFullView(v, b)).toBe(true);
  });

  it("pans like dragging a map, and stops at the edges", () => {
    const zoomed = zoomAt(fullView(b), b, 0.5); // x 7.25–21.75, y 1.25–3.75
    const right = panBy(zoomed, b, 0.1, 0); // drag content right → window moves left
    expect(right.x0).toBeCloseTo(zoomed.x0 - 1.45);
    const down = panBy(zoomed, b, 0, 0.1); // drag content down → window moves up
    expect(down.y0).toBeCloseTo(zoomed.y0 + 0.25);
    const far = panBy(zoomed, b, 10, -10);
    expect(far.x0).toBe(0);
    expect(far.y0).toBe(0);
    expect(far.x1 - far.x0).toBeCloseTo(14.5); // span kept
  });

  it("handles a single bucket (no x range)", () => {
    const one: Bounds = { xMax: 0, yMin: 0, yMax: 5, minX: 0, minY: 0.5 };
    expect(clampView(zoomAt(fullView(one), one, 0.5), one)).toMatchObject({ x0: 0, x1: 0 });
  });

  it("puts gridlines on round steps, at least three", () => {
    expect(niceTicks(0, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(2.1, 3.9)).toEqual([2.5, 3, 3.5]);
    expect(niceTicks(3, 3.5)).toEqual([3, 3.1, 3.2, 3.3, 3.4, 3.5]);
  });
});
