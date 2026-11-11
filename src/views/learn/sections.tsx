// =========================================================
// Learn SECTION registry — the ways into new material that stack under the level bands
// (Lessons, Articles, …). Mirrors the language / difficulty / senses registries: a new
// section is one entry here, and LearnView knows nothing about any particular one.
//
// The contract every section gets:
//   - `langs`: the profile pair (learning + the language it is explained in). Sections
//     own no language picker — the profile is the one answer to "what am I learning".
//   - `ready`: the pair has settled, so a section doesn't fetch for the DEFAULT
//     language and immediately refetch for the real one.
//   - `onTakeover(open)`: "I have opened something that needs the whole tab" (an
//     article analysis, a lesson). LearnView then folds away its own chrome AND the
//     other sections — hidden, never unmounted, so the section that took over keeps its
//     state and the others keep theirs.
//
// Lives in views/ rather than services/ because entries carry React components; the
// services layer stays UI-free for the native track (#18).
// =========================================================
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { LangCode } from "../../services/language";
import type { MessageKey } from "../../i18n/messages";

export interface LearnSectionProps {
  userId: string;
  langs: { learning: LangCode; native: LangCode };
  ready: boolean;
  onTakeover: (open: boolean) => void;
}

export interface LearnSection {
  id: string;
  /** A heading LearnView renders above the section. Omit when the section titles itself
   *  (e.g. Lessons, which hides entirely for a language with nothing published). */
  titleKey?: MessageKey;
  /** Lazy: each section is its own chunk, so the tab everyone opens doesn't pay for them. */
  Component: LazyExoticComponent<ComponentType<LearnSectionProps>>;
}

export const LEARN_SECTIONS: readonly LearnSection[] = [
  {
    id: "lessons",
    Component: lazy(() => import("../LessonsSection").then((m) => ({ default: m.LessonsSection }))),
  },
  {
    id: "articles",
    titleKey: "learn.articles",
    // MediaView predates the registry; adapt its `onArticleOpen` to the shared contract.
    Component: lazy(() =>
      import("../MediaView").then(({ MediaView }) => ({
        default: ({ onTakeover, ...rest }: LearnSectionProps) => <MediaView {...rest} onArticleOpen={onTakeover} />,
      })),
    ),
  },
];
