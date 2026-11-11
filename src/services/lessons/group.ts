// Lessons — order the manifest for display: by the learning language's band (easiest
// first, via its proficiency framework), then `order`. Lessons with no level, or a
// label the framework doesn't know, go last under one "other" group. PURE.
import { proficiencyFrameworkFor } from "../proficiency";
import type { LangCode } from "../language";
import type { LessonSummary } from "./types";

export interface LevelGroup {
  /** The band label as authored ("N5"), or null for the unlevelled group. */
  level: string | null;
  lessons: LessonSummary[];
}

export function groupLessonsByLevel(lessons: LessonSummary[], language: LangCode): LevelGroup[] {
  const bands = proficiencyFrameworkFor(language)?.bands ?? [];
  const rank = (level: string | null) => {
    const i = level == null ? -1 : bands.findIndex((b) => b.label.toUpperCase() === level.toUpperCase());
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const groups = new Map<string, LevelGroup>();
  for (const l of lessons) {
    const known = rank(l.level) !== Number.MAX_SAFE_INTEGER;
    const key = known ? l.level!.toUpperCase() : "\u0000other";
    if (!groups.has(key)) groups.set(key, { level: known ? l.level!.toUpperCase() : null, lessons: [] });
    groups.get(key)!.lessons.push(l);
  }
  return [...groups.values()]
    .sort((a, b) => rank(a.level) - rank(b.level))
    .map((g) => ({ ...g, lessons: [...g.lessons].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) }));
}
