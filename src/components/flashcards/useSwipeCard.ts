// Swipe-to-rate MOTION for a card: the card follows the pointer while you drag,
// flies out in the direction you rated, and springs back if you let go short of the
// commit distance. The rating itself is committed only when the fly-out finishes, so
// the next card never appears under a card that is still leaving.
//
// It owns the gesture as well as the animation, which is why FlashcardCard's own
// touch-swipe props are NOT passed alongside it — both would fire on the same
// release and rate the word twice.
//
// `fling()` is the imperative door in, so the ←/→ buttons and the arrow keys animate
// exactly like a real swipe instead of teleporting to the next card.
//
// An UP-swipe is the optional third gesture (`onUp`): it reveals the answer. It never
// flies the card out — revealing isn't a rating — so the card lifts a little with the
// finger and settles back once it lets go. Without `onUp` a vertical drag is ignored.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export type SwipeDir = "left" | "right";

/** Release past this many px commits the rating; below it the card springs back. */
const COMMIT_PX = 60;
/** Movement under this is still a tap — the card flips instead of moving. */
const TAP_SLOP = 8;
/** Fly-out duration. MUST match the .swipecard transition in flashcards.css. */
const EXIT_MS = 240;
/** How much the card tilts as it travels (capped, or it reads as a spin). */
const TILT_PER_PX = 0.06;
const MAX_TILT = 14;
/** How far off-stage the card flies — past 100% it is fully out of the frame. */
const EXIT_DISTANCE = "140%";
/** How far the card lifts with an up-swipe: it follows the finger at half speed and
 *  stops here, so it reads as "flip" rather than as the card leaving. */
const MAX_LIFT_PX = 36;

const tilt = (dx: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, dx * TILT_PER_PX));

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export interface SwipeCardProps {
  className: string;
  style: CSSProperties;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClickCapture: (e: ReactMouseEvent<HTMLDivElement>) => void;
}

export function useSwipeCard({
  onLeft,
  onRight,
  onUp,
}: {
  onLeft: () => void;
  onRight: () => void;
  /** Up-swipe past the commit distance — reveal the answer. Omit to ignore vertical drags. */
  onUp?: () => void;
}): {
  /** Spread onto the element that should move (it wraps the card). */
  props: SwipeCardProps;
  /** Rate in a direction WITH the fly-out — for buttons and keyboard. */
  fling: (dir: SwipeDir) => void;
} {
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [exit, setExit] = useState<SwipeDir | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  // A drag that passed TAP_SLOP: suppresses the click it would otherwise end in
  // (a click on the card flips it, which is not what a swipe meant).
  const moved = useRef(false);
  // Which way the drag was claimed once it passed TAP_SLOP. Fixed for the rest of the
  // gesture, so a swipe up that drifts sideways never turns into a rating.
  const axis = useRef<"x" | "y">("x");
  const exiting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const fling = useCallback(
    (dir: SwipeDir) => {
      if (exiting.current) return; // one commit per card, however it was triggered
      const commit = dir === "left" ? onLeft : onRight;
      if (prefersReducedMotion()) {
        setDx(0);
        commit();
        return;
      }
      exiting.current = true;
      setExit(dir);
      timer.current = setTimeout(() => {
        exiting.current = false;
        // Reset to rest in the SAME tick as the commit, so the incoming card is
        // rendered centred rather than inheriting the outgoing card's transform.
        setExit(null);
        setDx(0);
        commit();
      }, EXIT_MS);
    },
    [onLeft, onRight],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (exiting.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    moved.current = false;
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const moveX = e.clientX - d.x;
    const moveY = e.clientY - d.y;
    if (!moved.current) {
      const vertical = Math.abs(moveY) > TAP_SLOP && Math.abs(moveY) > Math.abs(moveX);
      if (vertical) {
        // Vertical intent with no up-gesture to offer → not ours. Drop it.
        if (!onUp) {
          drag.current = null;
          return;
        }
        axis.current = "y";
      } else {
        if (Math.abs(moveX) <= TAP_SLOP) return;
        axis.current = "x";
      }
      moved.current = true;
      // Keep receiving moves/up even if the pointer leaves the card.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (axis.current === "y") setDy(Math.max(-MAX_LIFT_PX, Math.min(0, moveY / 2)));
    else setDx(moveX);
  }, [onUp]);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      if (moved.current && axis.current === "y") {
        setDy(0); // settle back either way — revealing doesn't move the card on
        if (e.clientY - d.y <= -COMMIT_PX) onUp?.();
        return;
      }
      const moveX = e.clientX - d.x;
      if (moved.current && Math.abs(moveX) >= COMMIT_PX) fling(moveX < 0 ? "left" : "right");
      else setDx(0); // spring back
    },
    [fling, onUp],
  );

  const onPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDx(0);
    setDy(0);
  }, []);

  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!moved.current) return;
    // Swallow the click that ends a drag, so releasing a swipe never flips the card.
    e.preventDefault();
    e.stopPropagation();
    moved.current = false;
  }, []);

  const dragging = (dx !== 0 || dy !== 0) && exit == null;
  // A transform is emitted ONLY while the card is moving: a permanent one would make
  // this element the containing block for the add-to-list menu (position: fixed) and
  // land it in the wrong place.
  const style: CSSProperties = exit
    ? {
        transform: `translateX(${exit === "left" ? "-" : ""}${EXIT_DISTANCE}) rotate(${exit === "left" ? -MAX_TILT : MAX_TILT}deg)`,
        opacity: 0,
      }
    : dragging
      ? dy !== 0
        ? { transform: `translateY(${dy}px)` }
        : { transform: `translateX(${dx}px) rotate(${tilt(dx).toFixed(2)}deg)` }
      : {};

  return {
    props: {
      className: `swipecard${dragging ? " swipecard--dragging" : ""}`,
      style,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
    fling,
  };
}
