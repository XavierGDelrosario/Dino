// =========================================================
// Handwriting input pad — capture strokes, recognize them on-device, and let the
// user pick a candidate that fills the translate input. Stroke capture is the easy
// part; the recognizer (services/handwriting) is the swappable backend.
//
// Pointer events (not mouse/touch) so one path covers Apple Pencil / finger /
// trackpad; `touch-action: none` on the pad (CSS) stops the page scrolling while
// drawing. Canvas pixel coords == the InkInput coordinate space we hand the
// recognizer, so width/height are just the canvas's intrinsic size.
// =========================================================
import { useEffect, useRef, useState } from "react";
import {
  recognizeHandwriting,
  type InkPoint,
  type RecognitionCandidate,
  type Stroke,
} from "../../services/handwriting";
import type { LangCode } from "../../services/language";
import { useI18n } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";

const PAD_SIZE = 280;

/** Fallback if the stylesheet hasn't resolved (or --hw-ink is ever removed). */
const INK_FALLBACK = "#ffffff";

/**
 * Ink colour, read from the pad's own `--hw-ink` (set per theme in common.css,
 * alongside the `--hw-pad` background — the two are a pair and must never be
 * picked independently, or the strokes match the pad and vanish).
 *
 * Read from the DOM rather than imported as a constant because a canvas is
 * PIXELS: CSS can restyle the pad's background when the theme flips, but it
 * cannot recolour a stroke that has already been painted. So the component asks
 * the stylesheet what the ink is now, and repaints when the answer changes.
 */
function inkColor(canvas: HTMLCanvasElement | null): string {
  if (!canvas) return INK_FALLBACK;
  return getComputedStyle(canvas).getPropertyValue("--hw-ink").trim() || INK_FALLBACK;
}

/** The pen, applied identically to the live trace and the committed repaint. */
function setPen(ctx: CanvasRenderingContext2D, ink: string) {
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink;
}

function drawStroke(ctx: CanvasRenderingContext2D, points: InkPoint[]) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

export function HandwritingCanvas({
  lang,
  onPick,
  onClose,
}: {
  lang: LangCode;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const { t: tr } = useI18n();
  // Only for the repaint dependency below — the colour itself comes from the CSS
  // token, so the two can't disagree.
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The resolved ink, refreshed by the repaint effect below (the only place it can
  // change). Read from here while drawing: resolving the custom property per
  // pointermove is a style recalc 60–120×/s on the one interaction that must feel
  // like a pen, and it cannot return anything the effect did not already compute.
  const ink = useRef<string>("");
  const drawing = useRef<{ points: InkPoint[] } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [candidates, setCandidates] = useState<RecognitionCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repaint the committed strokes whenever they change (undo/clear/new stroke) —
  // and whenever the THEME changes, which is what re-inks work already on the pad
  // instead of leaving white strokes on white paper.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PAD_SIZE, PAD_SIZE);
    ink.current = inkColor(canvasRef.current);
    setPen(ctx, ink.current);
    for (const s of strokes) drawStroke(ctx, s.points);
  }, [strokes, theme]);

  // Selection is OFF across the document for as long as the pad is open — a stroke
  // is a drag, and a drag that leaves the canvas sweeps a selection through whatever
  // it crosses, including the textarea behind the overlay. See `.is-drawing` in
  // common.css for why the overlay's own rule can't cover that. Cleanup runs on every
  // unmount path (✕, a picked candidate, leaving the tab), so nothing can strand the
  // document in a non-selectable state.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("is-drawing");
    return () => root.classList.remove("is-drawing");
  }, []);

  // ABSOLUTE timestamp (ms since the page's time origin), so `t` increases
  // monotonically ACROSS strokes — ML Kit needs that for multi-stroke characters;
  // per-stroke-relative time resets to 0 each stroke and yields empty recognition.
  const point = (e: React.PointerEvent<HTMLCanvasElement>): InkPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: Math.round(e.timeStamp),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { points: [point(e)] };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current.points.push(point(e));
    // Live-draw the in-progress trace so the pen feels responsive. The repaint effect
    // only runs on COMMITTED strokes, so set the pen here too — otherwise the live
    // trace draws in the canvas default (black), invisible on the dark pad until the
    // stroke ends and the effect repaints it in the theme's ink.
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    if (!ink.current) ink.current = inkColor(canvasRef.current); // before the first repaint
    setPen(ctx, ink.current);
    drawStroke(ctx, drawing.current.points);
  };

  const endStroke = () => {
    const pending = drawing.current;
    drawing.current = null;
    if (pending && pending.points.length > 0) {
      setStrokes((prev) => [...prev, { points: pending.points }]);
    }
  };

  const clear = () => {
    setStrokes([]);
    setCandidates([]);
    setError(null);
  };

  const undo = () => {
    setStrokes((prev) => prev.slice(0, -1));
    setCandidates([]);
  };

  const recognize = async () => {
    if (strokes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const out = await recognizeHandwriting({ strokes, width: PAD_SIZE, height: PAD_SIZE, lang });
      setCandidates(out);
      if (out.length === 0) setError(tr("handwriting.noMatch"));
    } catch {
      setError(tr("handwriting.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hw">
      <div className="hw__bar">
        <span className="hw__hint">{tr("handwriting.hint")}</span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={onClose}
          aria-label={tr("handwriting.close")}
        >
          ✕
        </button>
      </div>

      <canvas
        ref={canvasRef}
        className="hw__pad"
        width={PAD_SIZE}
        height={PAD_SIZE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerLeave={endStroke}
        onPointerCancel={endStroke}
        aria-label={tr("handwriting.padAria")}
      />

      <div className="hw__controls">
        <button className="btn btn--ghost btn--sm" onClick={undo} disabled={strokes.length === 0}>
          {tr("handwriting.undo")}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={clear} disabled={strokes.length === 0}>
          {tr("handwriting.clear")}
        </button>
        <button className="btn btn--sm" onClick={recognize} disabled={busy || strokes.length === 0}>
          {busy ? "…" : tr("handwriting.recognize")}
        </button>
      </div>

      {error && <p className="hw__error">{error}</p>}

      {candidates.length > 0 && (
        <div className="hw__candidates" aria-label={tr("handwriting.candidatesAria")}>
          {candidates.map((c, i) => (
            <button
              key={`${c.text}-${i}`}
              className="hw__cand"
              onClick={() => {
                onPick(c.text);
                clear();
              }}
            >
              {c.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
