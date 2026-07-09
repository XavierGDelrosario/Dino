// The icon-button + dropdown-panel shell shared by the top-bar menus (language,
// profile). Controlled open state (the parent keeps the menus mutually exclusive);
// the caller supplies only the icon, aria label, and the panel's items.
import type { ReactNode } from "react";
import "./common.css";

export function PopoverMenu({
  icon,
  ariaLabel,
  open,
  onToggle,
  className = "",
  children,
}: {
  /** Emoji/glyph for the trigger button. */
  icon: string;
  ariaLabel: string;
  open: boolean;
  onToggle: () => void;
  /** Extra class on the wrapper (e.g. "langmenu" for positioning). */
  className?: string;
  /** The menu items (rendered inside the panel when open). */
  children: ReactNode;
}) {
  return (
    <div className={`profilemenu${className ? ` ${className}` : ""}`}>
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
