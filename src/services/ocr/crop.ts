// =========================================================
// Crop-rectangle geometry — pure, so the fiddly part of the cropper (drag maths,
// clamping, mapping the on-screen box back to source pixels) is unit-tested rather
// than eyeballed through a camera on a phone, which is the only place the UI is
// reachable.
//
// The rect is NORMALIZED 0..1 with a TOP-LEFT origin, matching OcrBlock — so it is
// independent of how big the image happens to be drawn, survives a rotation or a
// resize of the preview, and maps to source pixels with one multiply.
// =========================================================

/** A crop box in normalized 0..1 coordinates, top-left origin. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which grab handle is being dragged (or the whole box). */
export type CropHandle = "nw" | "ne" | "sw" | "se" | "move";

/** Smallest crop we allow, as a fraction of the image. Below this the selection is
 *  too small to hold readable text and is almost certainly an accidental tap. */
export const MIN_CROP = 0.05;

/**
 * The default selection when a photo opens: the ENTIRE image.
 *
 * Not inset. An inset default looks tidier (the handles sit clear of the edges) but
 * it would quietly drop a border of the photo for anyone who just hits Recognize —
 * and the shaded margin would be telling the truth while isFullFrame() called it a
 * whole-frame capture. The handles overhang the edge instead (see cropper.css),
 * which keeps them grabbable without lying about what's selected.
 */
export const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Force a rect inside the image and no smaller than MIN_CROP, preserving its
 *  top-left where possible. Every mutation ends here, so no drag can produce a
 *  negative size or a box hanging off the edge. */
export function clampRect(rect: CropRect, min = MIN_CROP): CropRect {
  const width = Math.min(1, Math.max(min, rect.width));
  const height = Math.min(1, Math.max(min, rect.height));
  return {
    width,
    height,
    x: Math.min(1 - width, clamp01(rect.x)),
    y: Math.min(1 - height, clamp01(rect.y)),
  };
}

/** Translate the whole box, stopping at the image edges (it never shrinks). */
export function moveRect(rect: CropRect, dx: number, dy: number): CropRect {
  return {
    ...rect,
    x: Math.min(1 - rect.width, clamp01(rect.x + dx)),
    y: Math.min(1 - rect.height, clamp01(rect.y + dy)),
  };
}

/**
 * Drag one corner by (dx, dy). The OPPOSITE corner stays pinned — that's what makes
 * a corner drag feel like resizing rather than moving — and the box stops at
 * MIN_CROP instead of inverting when dragged past its own far edge.
 */
export function resizeRect(rect: CropRect, handle: CropHandle, dx: number, dy: number, min = MIN_CROP): CropRect {
  if (handle === "move") return moveRect(rect, dx, dy);

  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  const west = handle === "nw" || handle === "sw";
  const north = handle === "nw" || handle === "ne";

  // Move the dragged edges; the opposite ones are fixed anchors.
  const newLeft = west ? Math.min(clamp01(left + dx), right - min) : left;
  const newRight = west ? right : Math.max(clamp01(right + dx), left + min);
  const newTop = north ? Math.min(clamp01(top + dy), bottom - min) : top;
  const newBottom = north ? bottom : Math.max(clamp01(bottom + dy), top + min);

  return clampRect(
    { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop },
    min,
  );
}

/** Source-pixel rect for canvas drawImage. Rounded, and guaranteed at least 1px in
 *  each axis — drawImage with a zero-size source throws. */
export function toPixels(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.round(rect.x * imageWidth);
  const sy = Math.round(rect.y * imageHeight);
  return {
    sx,
    sy,
    sw: Math.max(1, Math.min(imageWidth - sx, Math.round(rect.width * imageWidth))),
    sh: Math.max(1, Math.min(imageHeight - sy, Math.round(rect.height * imageHeight))),
  };
}

/** Is this selection effectively the whole image? Then the crop is a no-op and the
 *  original bytes can be recognized as-is — no canvas round-trip, no requantizing
 *  a JPEG that OCR is about to read. */
export function isFullFrame(rect: CropRect, epsilon = 0.02): boolean {
  return (
    rect.x <= epsilon &&
    rect.y <= epsilon &&
    rect.width >= 1 - epsilon * 2 &&
    rect.height >= 1 - epsilon * 2
  );
}
