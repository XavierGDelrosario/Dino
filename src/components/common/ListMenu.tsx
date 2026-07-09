// The shared "file this into a sub-list" popover: a list of the user's sub-lists
// plus an inline "New list…" create input. Used everywhere a word can be tagged —
// the translate/quiz add button (via AddToListButton) and the list-view row — so
// creating a list on the fly works identically on all of them.
//
// It FLOATS over the content (position:fixed, anchored to the caller's button) so
// it overlays rather than growing the card, and escapes any overflow clipping
// (e.g. the reader's hovercard). It flips above the anchor when there's little
// room below. Callers own only what "pick"/"create" mean (add-to-ALL, tag, …).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { List } from "../../services/lists";
import { useI18n } from "../../i18n";
import "./ListMenu.css";

export function ListMenu({
  anchorRef,
  lists,
  title,
  onPick,
  onCreate,
  onClose,
}: {
  /** The button the menu anchors to (position is computed from its rect). */
  anchorRef: RefObject<HTMLElement>;
  lists: List[];
  title?: string;
  /** Chose an existing sub-list. */
  onPick: (listId: string) => void | Promise<void>;
  /** Typed a new sub-list name (create it, then file into it). */
  onCreate: (name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position against the anchor (fixed + these offsets float it over the content
  // and let overflow:auto scroll a long list). Recomputed on scroll/resize so it
  // TRACKS the button — a fixed element positioned only once detaches as the view
  // scrolls (the anchor moves, the menu doesn't).
  const reposition = useCallback(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const MENU_W = 192; // matches .addmenu min-width (12rem)
    const GAP = 6;
    const MARGIN = 8;
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const flipUp = below < 220 && above > below;
    const space = (flipUp ? above : below) - MARGIN;
    setStyle({
      position: "fixed",
      left: Math.round(Math.max(MARGIN, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - MARGIN))),
      maxHeight: Math.round(Math.max(160, Math.min(space, 360))),
      ...(flipUp
        ? { bottom: Math.round(window.innerHeight - r.top + GAP) }
        : { top: Math.round(r.bottom + GAP) }),
    });
  }, [anchorRef]);

  useLayoutEffect(reposition, [reposition]); // before paint (no flash)

  // Keep tracking the anchor while the view scrolls/resizes. capture=true catches
  // scrolls inside ANY nested scroll container (scroll doesn't bubble).
  useEffect(() => {
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [reposition]);

  // Dismiss on a tap/click outside the menu (and outside the anchor, so the anchor's
  // own toggle still works). pointerdown fires on iOS WKWebView + desktop.
  useEffect(() => {
    const onOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [anchorRef, onClose]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    await onCreate(n);
    setCreating(false);
    setName("");
  };

  return (
    <div ref={menuRef} className="addmenu" role="menu" style={style ?? undefined}>
      {title && <div className="addmenu__title">{title}</div>}
      {lists.map((l) => (
        <button key={l.listId} className="addmenu__item" onClick={() => onPick(l.listId)}>
          {l.listName}
        </button>
      ))}
      {creating ? (
        <div className="addmenu__create">
          <input
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("lists.newListPlaceholder")}
            aria-label={t("lists.newListAria")}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <button className="iconbtn" title={t("common.create")} onClick={create}>✓</button>
          <button
            className="iconbtn"
            title={t("common.cancel")}
            onClick={() => {
              setCreating(false);
              setName("");
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        <button className="addmenu__item addmenu__new" onClick={() => setCreating(true)}>
          {t("add.newListEllipsis")}
        </button>
      )}
      <button className="addmenu__close" onClick={onClose}>
        {t("add.done")}
      </button>
    </div>
  );
}
