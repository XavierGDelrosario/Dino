// =========================================================
// Crop the photo before it's recognized. Vision reads EVERYTHING it can see, so a
// photo of one line in a book comes back with the facing page, the header and the
// page number in it — this is where the user says "just this bit".
//
// Pointer events (not mouse/touch) so one path covers finger / Pencil / trackpad,
// with `touch-action: none` on the frame so dragging a handle doesn't scroll the
// page behind it. All the drag maths lives in services/ocr/crop.ts (pure, tested);
// this component only turns pointer deltas into normalized ones and paints.
// =========================================================
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_CROP,
  isFullFrame,
  moveRect,
  resizeRect,
  toPixels,
  type CropHandle,
  type CropRect,
} from "../../services/ocr";
import { useI18n } from "../../i18n";
import "./cropper.css";

const HANDLES: CropHandle[] = ["nw", "ne", "sw", "se"];

/** Crop `img` to `rect` and return base64 (no data: prefix), or null if the canvas
 *  is unavailable. A full-frame selection returns null so the caller can send the
 *  ORIGINAL bytes — re-encoding an untouched photo only costs quality. */
function cropToBase64(img: HTMLImageElement, rect: CropRect): string | null {
  if (isFullFrame(rect)) return null;
  const { sx, sy, sw, sh } = toPixels(rect, img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  // Quality 0.92: OCR is sensitive to compression artifacts around thin strokes,
  // and this image is thrown away right after recognition.
  return canvas.toDataURL("image/jpeg", 0.92).split(",")[1] ?? null;
}

export function ImageCropper({
  src,
  busy = false,
  onCancel,
  onCrop,
}: {
  /** data: URL of the captured photo. */
  src: string;
  /** Recognition in flight — the buttons lock rather than firing twice. */
  busy?: boolean;
  onCancel: () => void;
  /** The region to recognize: cropped base64, or null meaning "the whole photo". */
  onCrop: (base64: string | null) => void;
}) {
  const { t } = useI18n();
  const [rect, setRect] = useState<CropRect>(DEFAULT_CROP);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The live drag: which handle, and the last pointer position in normalized units.
  const drag = useRef<{ handle: CropHandle; x: number; y: number } | null>(null);

  /** Pointer position as a fraction of the frame — the space the rect lives in. */
  const normalize = (e: ReactPointerEvent): { x: number; y: number } | null => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  };

  const startDrag = (handle: CropHandle) => (e: ReactPointerEvent) => {
    const p = normalize(e);
    if (!p) return;
    e.stopPropagation(); // a handle drag is not also a box drag
    drag.current = { handle, ...p };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = normalize(e);
    if (!p) return;
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    drag.current = { ...d, ...p };
    setRect((r) => (d.handle === "move" ? moveRect(r, dx, dy) : resizeRect(r, d.handle, dx, dy)));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const confirm = () => {
    const img = imgRef.current;
    onCrop(img ? cropToBase64(img, rect) : null);
  };

  // Percentages so the box tracks the image through any resize/rotation.
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  return (
    <div className="cropper">
      <p className="cropper__hint">{t("ocr.cropHint")}</p>

      <div
        className="cropper__frame"
        ref={frameRef}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img ref={imgRef} className="cropper__img" src={src} alt={t("ocr.photoAria")} />

        {/* Four shades around the selection, so everything outside it reads as
            excluded. Cheaper and crisper than one box-shadow-spread overlay. */}
        <div className="cropper__shade" style={{ left: 0, top: 0, width: "100%", height: pct(rect.y) }} />
        <div
          className="cropper__shade"
          style={{ left: 0, top: pct(rect.y + rect.height), width: "100%", bottom: 0 }}
        />
        <div
          className="cropper__shade"
          style={{ left: 0, top: pct(rect.y), width: pct(rect.x), height: pct(rect.height) }}
        />
        <div
          className="cropper__shade"
          style={{ left: pct(rect.x + rect.width), top: pct(rect.y), right: 0, height: pct(rect.height) }}
        />

        <div
          className="cropper__box"
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
          onPointerDown={startDrag("move")}
          role="group"
          aria-label={t("ocr.cropAria")}
        >
          {HANDLES.map((h) => (
            <span
              key={h}
              className={`cropper__handle cropper__handle--${h}`}
              onPointerDown={startDrag(h)}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>

      <div className="cropper__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn--primary" onClick={confirm} disabled={busy}>
          {busy ? "…" : t("ocr.recognize")}
        </button>
      </div>
    </div>
  );
}
