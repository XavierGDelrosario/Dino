// =========================================================
// Lessons — PURE parsing of the fetched JSON into the domain types.
//
// Everything off the network is untrusted shape: a typo in a published file must not
// crash the Learn tab, and a block written for a NEWER build must not break this one.
// So parsing is lenient where that is safe and strict where it is not:
//   - an unknown block type, or a malformed block, is DROPPED (with a warning), and the
//     rest of the lesson renders;
//   - a manifest entry that is malformed, or needs a newer schema, is DROPPED from the
//     list;
//   - only a file that isn't a lesson/manifest at all (wrong top-level shape) throws.
// Shared by the client and scripts/publish-lessons.ts, which runs it in STRICT mode so
// a mistake is caught before upload rather than silently skipped on every device.
// =========================================================
import {
  LESSON_SCHEMA,
  type ImageRef,
  type LessonCard,
  type Lesson,
  type LessonBlock,
  type LessonIndex,
  type LessonSummary,
  type Localized,
} from "./types";
import type { LangCode } from "../language";

export class LessonFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonFormatError";
  }
}

export interface ParseOptions {
  /** Throw on any dropped block / entry instead of skipping it (the publish script). */
  strict?: boolean;
  /** Collects a note per dropped piece (defaults to console.warn). */
  onIssue?: (message: string) => void;
}

/** Lesson ids are path segments and object names — keep them boring. */
export const LESSON_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function issue(opts: ParseOptions, message: string): void {
  if (opts.strict) throw new LessonFormatError(message);
  (opts.onIssue ?? ((m) => console.warn(`lessons: ${m}`)))(message);
}

/** A `{ "EN": "...", "JA": "..." }` map, keeping only non-empty string values. */
function localized(v: unknown): Localized {
  if (!isObj(v)) return {};
  const out: Localized = {};
  for (const [k, s] of Object.entries(v)) if (isStr(s)) out[k.toUpperCase()] = s;
  return out;
}
const hasAny = (l: Localized) => Object.keys(l).length > 0;

/**
 * An image path relative to the language folder. Deliberately NOT a URL: a lesson can
 * only point at images published beside it, never hotlink an arbitrary host (or a
 * `javascript:`/`data:` src) into the page.
 */
export const IMAGE_PATH = /^images\/[\w.-]+\.(png|jpe?g|webp|gif)$/i;

function imageRef(v: unknown): ImageRef | null {
  if (isStr(v)) return IMAGE_PATH.test(v) ? { src: v, alt: {} } : null;
  if (isObj(v) && isStr(v.src) && IMAGE_PATH.test(v.src)) return { src: v.src, alt: localized(v.alt) };
  return null;
}

function parseBlock(raw: unknown): LessonBlock | string {
  if (!isObj(raw)) return "block is not an object";
  switch (raw.type) {
    case "text": {
      const body = localized(raw.body);
      return hasAny(body) ? { type: "text", body } : "text block has no body";
    }
    case "pattern":
      return isStr(raw.pattern)
        ? { type: "pattern", pattern: raw.pattern, note: localized(raw.note) }
        : "pattern block has no pattern";
    case "example":
      return isStr(raw.text)
        ? { type: "example", text: raw.text.trim().normalize("NFC"), gloss: localized(raw.gloss) }
        : "example block has no text";
    case "choice": {
      const options = Array.isArray(raw.options) ? raw.options.filter(isStr) : [];
      const prompt = localized(raw.prompt);
      const answer = raw.answer;
      if (!hasAny(prompt)) return "choice block has no prompt";
      if (options.length < 2 || options.length !== (raw.options as unknown[]).length)
        return "choice block needs 2+ non-empty options";
      if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= options.length)
        return "choice block answer is not an option index";
      return { type: "choice", prompt, options, answer, explanation: localized(raw.explanation) };
    }
    case "image": {
      const image = imageRef(raw.image);
      return image ? { type: "image", image, caption: localized(raw.caption) } : "image block has no valid image";
    }
    case "cards": {
      if (!Array.isArray(raw.cards)) return "cards block has no cards";
      const cards: LessonCard[] = [];
      for (const [i, c] of raw.cards.entries()) {
        if (!isObj(c) || !isStr(c.front) || !isStr(c.back)) return `card ${i} needs a front and a back`;
        if (c.image !== undefined && !imageRef(c.image)) return `card ${i} has an invalid image`;
        cards.push({
          front: c.front.trim().normalize("NFC"),
          back: c.back.trim().normalize("NFC"),
          note: localized(c.note),
          image: imageRef(c.image),
          word: isStr(c.word) ? c.word.trim().normalize("NFC") : null,
        });
      }
      if (cards.length === 0) return "cards block is empty";
      return {
        type: "cards",
        title: localized(raw.title),
        cards,
        shuffle: raw.shuffle !== false,
        lookup: raw.lookup !== false,
      };
    }
    default:
      // Not an error — a block for a newer build. Skipped silently in lenient mode.
      return `unknown block type ${JSON.stringify(raw.type)}`;
  }
}

function schemaOf(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
}

export function parseLesson(raw: unknown, opts: ParseOptions = {}): Lesson {
  if (!isObj(raw)) throw new LessonFormatError("lesson is not an object");
  if (!isStr(raw.id) || !LESSON_ID.test(raw.id)) throw new LessonFormatError("lesson has no valid id");
  if (!isStr(raw.language)) throw new LessonFormatError(`lesson ${raw.id} has no language`);
  const schema = schemaOf(raw.schema);
  if (schema > LESSON_SCHEMA)
    throw new LessonFormatError(`lesson ${raw.id} needs schema ${schema} (this build reads ${LESSON_SCHEMA})`);
  const title = localized(raw.title);
  if (!hasAny(title)) throw new LessonFormatError(`lesson ${raw.id} has no title`);
  if (!Array.isArray(raw.blocks)) throw new LessonFormatError(`lesson ${raw.id} has no blocks`);

  const blocks: LessonBlock[] = [];
  raw.blocks.forEach((b, i) => {
    const parsed = parseBlock(b);
    if (typeof parsed === "string") issue(opts, `lesson ${raw.id} block ${i}: ${parsed}`);
    else blocks.push(parsed);
  });
  return {
    id: raw.id,
    schema,
    language: raw.language.toUpperCase(),
    level: isStr(raw.level) ? raw.level : null,
    title,
    blocks,
  };
}

export function parseLessonIndex(raw: unknown, opts: ParseOptions = {}): LessonIndex {
  if (!isObj(raw) || !Array.isArray(raw.lessons)) throw new LessonFormatError("index has no lessons array");
  if (!isStr(raw.language)) throw new LessonFormatError("index has no language");
  const lessons: LessonSummary[] = [];
  const seen = new Set<string>();
  raw.lessons.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.id) || !LESSON_ID.test(e.id) || !isStr(e.file) || !/^[\w.-]+\.json$/.test(e.file)) {
      issue(opts, `index entry ${i} is malformed`);
      return;
    }
    const title = localized(e.title);
    if (!hasAny(title)) return issue(opts, `index entry ${e.id} has no title`);
    if (seen.has(e.id)) return issue(opts, `index entry ${e.id} is duplicated`);
    const schema = schemaOf(e.schema);
    if (schema > LESSON_SCHEMA) return; // for a newer build — not an error, just not ours
    seen.add(e.id);
    lessons.push({
      id: e.id,
      file: e.file,
      schema,
      level: isStr(e.level) ? e.level : null,
      order: typeof e.order === "number" && Number.isFinite(e.order) ? e.order : 0,
      title,
      summary: localized(e.summary),
    });
  });
  return { schema: schemaOf(raw.schema), language: raw.language.toUpperCase(), lessons };
}

/**
 * Pick the prose for the reader's native language: exact match, else English, else
 * whatever the author wrote first. Returns "" only for an empty map.
 */
export function pickLocalized(text: Localized, native: LangCode): string {
  return text[native.toUpperCase()] ?? text.EN ?? Object.values(text).find(Boolean) ?? "";
}
