// Lessons — which languages a lesson's EXPLANATIONS are written in. PURE.
//
// Drives the lesson page's explanation-language switch: it only appears when the
// lesson actually carries prose in the other language, since pickLocalized would
// otherwise fall back and the switch would change nothing. Example GLOSSES are not
// explanation prose (they translate the example into the reader's own language), so
// they don't count.
import type { LangCode } from "../language";
import type { Lesson, Localized } from "./types";

export function proseLanguages(lesson: Lesson): Set<LangCode> {
  const out = new Set<LangCode>();
  const add = (l: Localized) => Object.keys(l).forEach((k) => out.add(k));
  add(lesson.title);
  for (const b of lesson.blocks) {
    switch (b.type) {
      case "text":
        add(b.body);
        break;
      case "pattern":
        add(b.note);
        break;
      case "image":
        add(b.caption);
        break;
      case "cards":
        add(b.title);
        b.cards.forEach((c) => add(c.note));
        break;
      case "choice":
        add(b.prompt);
        add(b.explanation);
        break;
      case "example":
        break;
    }
  }
  return out;
}
