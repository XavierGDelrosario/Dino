// The five-dot confidence readout (0–5), shared by the Lists rows and the article
// word table — it was duplicated in both, and the interactive half below is exactly
// the kind of thing that would have drifted between two copies.
//
// Given `onForgot`, the dots BECOME the trigger for the same one-notch drop the
// reader's hovercard "Forgot" performs (services/review.softenConfidence): pressing
// them opens a small "Forgot?" overlay above, and confirming it fires the callback.
// The trigger is a <button> with its chrome stripped ON PURPOSE — it must read as the
// same readout it has always been, so nothing here may give it a border, a background
// or a hover fill.
//
// Only ONE overlay exists on screen at a time. That is enforced by a MODULE-level
// singleton rather than per-list state, because the rule is about the SCREEN: Lists and
// the article table each render their own rows, and a second surface must be able to
// close the first one's overlay without the two knowing about each other.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SOFTEN_MIN_CONFIDENCE } from "../../services/review";
import { useI18n } from "../../i18n";
import "../lists/lists.css"; // .dots / .dot live with the Lists row this mirrors

// ── the "one overlay per screen" singleton ──────────────────────────────────
let openId: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const getOpenId = () => openId;
function setOpenId(id: string | null) {
  if (openId === id) return;
  openId = id;
  for (const fn of [...listeners]) fn();
}

export function ConfidenceDots({
  rating,
  onForgot,
}: {
  rating: number;
  /** Lower this word by one displayed-confidence bucket. Omit and the dots stay inert
   *  text — which is also what a word BELOW the soften floor gets, since the server
   *  no-ops there and a control that silently does nothing is worse than none. */
  onForgot?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const open = useSyncExternalStore(subscribe, getOpenId, getOpenId) === id;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [busy, setBusy] = useState(false);
  const interactive = !!onForgot && rating >= SOFTEN_MIN_CONFIDENCE;

  // Never leave the singleton pointing at a row that has been paged/filtered away —
  // it would swallow the NEXT row's first press (the store would already read "open"
  // for an id nothing renders).
  useEffect(
    () => () => {
      if (openId === id) setOpenId(null);
    },
    [id],
  );

  // Anywhere else closes it. CAPTURE phase, so the dismissal lands before whatever was
  // clicked acts on it; pointerdown rather than click so a press that ends in a drag
  // still dismisses. The wrapper holds both the trigger and the overlay, so a press on
  // either is "inside" and this leaves it alone.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const press = useCallback(async () => {
    if (!onForgot || busy) return;
    setBusy(true);
    try {
      await onForgot();
      setOpenId(null); // the overlay closing IS the acknowledgement; the dots then drop
    } finally {
      setBusy(false);
    }
  }, [onForgot, busy]);

  const dots = (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`dot${i < rating ? " dot--on" : ""}`} />
      ))}
    </>
  );

  if (!interactive) {
    return (
      <span className="dots" aria-label={t("lists.confidenceOf", { n: rating })}>
        {dots}
      </span>
    );
  }

  return (
    <span className="dots-wrap" ref={wrapRef}>
      {open && (
        <button type="button" className="dots-pop" onClick={press} disabled={busy}>
          {t("lists.forgotQ")}
        </button>
      )}
      <button
        type="button"
        className="dots dots-btn"
        aria-label={t("lists.confidenceForgot", { n: rating })}
        aria-expanded={open}
        onClick={() => setOpenId(open ? null : id)}
      >
        {dots}
      </button>
    </span>
  );
}
