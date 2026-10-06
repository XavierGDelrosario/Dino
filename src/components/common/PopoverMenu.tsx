// The icon-button + dropdown-panel shell shared by the top-bar menus (language,
// profile). Controlled open state (the parent keeps the menus mutually exclusive);
// the caller supplies only the icon, aria label, and the panel's items. It closes
// itself on a tap outside or Escape, through the caller's `onClose`.
import { useEffect, useRef, type ReactNode } from "react";
import "./common.css";

export function PopoverMenu({
  icon,
  ariaLabel,
  open,
  onToggle,
  onClose,
  className = "",
  children,
}: {
  /** Emoji/glyph for the trigger button. */
  icon: string;
  ariaLabel: string;
  open: boolean;
  onToggle: () => void;
  /** Close the menu: called on a tap/click anywhere outside it, and on Escape. */
  onClose?: () => void;
  /** Extra class on the wrapper (e.g. "langmenu" for positioning). */
  className?: string;
  /** The menu items (rendered inside the panel when open). */
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // While open, a tap anywhere else dismisses it — a menu that only its own button can
  // close reads as stuck. pointerdown (capture) fires on iOS WKWebView + desktop, and a
  // press on the button itself is INSIDE the wrap, so its own toggle still works; a
  // press on the OTHER menu's button closes this one first and then opens that one.
  // Same pattern as the word "?" panel (WordInfo's InfoButton).
  useEffect(() => {
    if (!open || !onClose) return;
    const onOutside = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className={`profilemenu${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        className="profilemenu__btn"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        onClick={onToggle}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
      {open && (
        <div className="profilemenu__panel" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
