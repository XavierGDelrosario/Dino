// Collapsible level groups for a Learn content list (Lessons, Quizzes): each band label
// (N5, N4, …) is a toggle button that shows or hides its items.
//
// Which groups start open: the user's own level when it has a group here, else the
// first (easiest) group — so the list opens on something to do rather than a wall of
// closed headers. After that the user's choice wins and is remembered per device
// (per list, so Lessons and Quizzes keep their own).
import { useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { LevelGroup } from "../../services/lessons";
import type { LessonSummary } from "../../services/lessons";

const STORE = "dino.learn.openLevels.";
const keyOf = (level: string | null) => level ?? "__other";

function readOpen(storageKey: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(STORE + storageKey);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? new Set(v.filter((x) => typeof x === "string")) : null;
  } catch {
    return null;
  }
}
function writeOpen(storageKey: string, open: Set<string>): void {
  try {
    localStorage.setItem(STORE + storageKey, JSON.stringify([...open]));
  } catch {
    /* blocked storage — toggles still work for this visit */
  }
}

export function LevelGroups({
  groups,
  storageKey,
  userLevel,
  renderItem,
}: {
  groups: LevelGroup[];
  /** Separates this list's remembered open/closed state from other lists'. */
  storageKey: string;
  /** The user's band label ("N3"), or null when not estimated yet. */
  userLevel: string | null;
  renderItem: (item: LessonSummary) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Set<string>>(() => {
    const saved = readOpen(storageKey);
    if (saved) return saved;
    const mine = groups.find((g) => userLevel && g.level?.toUpperCase() === userLevel.toUpperCase());
    const first = mine ?? groups[0];
    return new Set(first ? [keyOf(first.level)] : []);
  });

  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      writeOpen(storageKey, next);
      return next;
    });

  return (
    <div className="levelgroups">
      {groups.map((g) => {
        const k = keyOf(g.level);
        const isOpen = open.has(k);
        return (
          <div key={k} className={`levelgroup${isOpen ? " levelgroup--open" : ""}`}>
            <button
              type="button"
              className="levelgroup__toggle"
              aria-expanded={isOpen}
              onClick={() => toggle(k)}
            >
              <span className="levelgroup__label">{g.level ?? t("lessons.other")}</span>
              <span className="levelgroup__chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            {isOpen && (
              <ul className="lessons__list levelgroup__items">
                {g.lessons.map((l) => (
                  <li key={l.id}>{renderItem(l)}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
