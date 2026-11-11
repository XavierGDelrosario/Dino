// A Learn section (Lessons · Vocab · Quizzes · Articles) with a collapsible heading:
// the title is a toggle with its arrow beside it — the same discreet control as the
// N5/N4 level groups inside — between a separator line above and below.
//
// Collapsed content is HIDDEN, not unmounted: Articles holds a fetched browse and an
// open article, and folding the section away must not throw that out. Open/closed is
// remembered per device per section; sections start open.
//
// `bare`: render the content alone, no heading, always visible — for a section that
// has taken over the tab (an open article), where a toggle would fold away the page
// the user is reading.
import { useState, type ReactNode } from "react";

const STORE = "dino.learn.sectionClosed";

function readClosed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeClosed(closed: Set<string>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...closed]));
  } catch {
    /* blocked storage — the toggle still works for this visit */
  }
}

export function LearnSection({
  id,
  title,
  bare = false,
  children,
}: {
  /** Stable key for the remembered open/closed state. */
  id: string;
  title: string;
  bare?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !readClosed().has(id));
  if (bare) return <>{children}</>;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const closed = readClosed();
    if (next) closed.delete(id);
    else closed.add(id);
    writeClosed(closed);
  };

  return (
    <>
      <h2 className="learn__sectiontitle">
        <button
          type="button"
          className={`learn__sectiontoggle${open ? " learn__sectiontoggle--open" : ""}`}
          aria-expanded={open}
          onClick={toggle}
        >
          <span>{title}</span>
          <span className="learn__sectionchevron" aria-hidden="true">
            ▾
          </span>
        </button>
      </h2>
      <div hidden={!open}>{children}</div>
    </>
  );
}
