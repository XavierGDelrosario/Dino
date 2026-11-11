// =========================================================
// Lessons — the FILE FORMAT (schema 1) and the domain types the UI renders.
//
// Lessons are authored grammar explanations served as JSON from the public `lessons`
// Storage bucket (migration 20260796), NOT bundled — so a new or fixed lesson reaches
// installed apps without a release. That makes the format a PUBLIC CONTRACT with every
// build already in the wild, and the rules below exist to keep old builds working:
//
//   lessons/<LEARNING_LANG>/index.json        ← the manifest (short cache, re-checked)
//   lessons/<LEARNING_LANG>/<id>.<hash>.json  ← one lesson (content-addressed, immutable)
//
// 1. KEYED ON THE PAIR, never on Japanese. The folder is the LEARNING language; every
//    piece of explanation prose is a `Localized` map keyed by the NATIVE language
//    (falling back to EN). Adding a learning language = a new folder; explaining an
//    existing one in another native language = adding keys to the maps.
// 2. ADDITIVE EVOLUTION. A build skips any BLOCK type it doesn't know and ignores
//    unknown FIELDS, so a new block kind ("audio", "table") is published without
//    breaking older clients — they render the lesson minus that block.
// 3. `schema` IS FOR BREAKING CHANGES ONLY. A lesson whose `schema` exceeds
//    LESSON_SCHEMA is hidden from that build (listed in the manifest with its schema,
//    so the list can drop it without fetching). Bump it only when an old client would
//    render the lesson WRONGLY, not merely incompletely.
// 4. A FILE NEVER CHANGES ONCE PUBLISHED. The publish script names each lesson by its
//    content hash, so a lesson file can be cached forever; only index.json is
//    revalidated. That is what makes "edit a lesson" show up promptly everywhere.
// =========================================================
import type { LangCode } from "../language";

/** The newest lesson schema this build can render. */
export const LESSON_SCHEMA = 1;

/** Prose keyed by NATIVE language code ("EN", "JA", …). */
export type Localized = Partial<Record<LangCode, string>>;

/** One entry of index.json — enough to list and order a lesson without fetching it. */
export interface LessonSummary {
  id: string;
  /** Object name inside the language folder, e.g. "wa-desu.3f2a9c1b.json". */
  file: string;
  schema: number;
  /** The learning language's band LABEL ("N5", "A1") — resolved via services/proficiency. */
  level: string | null;
  /** Position within the level (ascending). */
  order: number;
  title: Localized;
  summary: Localized;
}

export interface LessonIndex {
  schema: number;
  /** The learning language this folder teaches. */
  language: LangCode;
  lessons: LessonSummary[];
}

/** Explanation paragraph(s), in the native language. Blank lines split paragraphs. */
export interface TextBlock {
  type: "text";
  body: Localized;
}

/** A structural pattern ("Noun は Noun です") with an optional native-language note. */
export interface PatternBlock {
  type: "pattern";
  pattern: string;
  note: Localized;
}

/**
 * A sentence IN THE LEARNING LANGUAGE. Rendered through ParagraphReader (furigana,
 * knowledge colouring, add-to-list) — never as a dead <p>.
 */
export interface ExampleBlock {
  type: "example";
  text: string;
  /** Its translation, keyed by native language. */
  gloss: Localized;
}

/** A single-answer multiple-choice check. */
export interface ChoiceBlock {
  type: "choice";
  /** The question, in the native language (may quote the learning language). */
  prompt: Localized;
  /** The options, as they appear — usually learning-language fragments. */
  options: string[];
  /** Index into `options`. */
  answer: number;
  /** Shown once answered. */
  explanation: Localized;
}

/**
 * An image stored beside the lessons. `src` is an object path RELATIVE TO THE LANGUAGE
 * FOLDER ("images/a.4c1d.png"); the publish script content-addresses it, so it is
 * cached forever like a lesson file. Resolved to a URL by `lessonAssetUrl`.
 */
export interface ImageRef {
  src: string;
  alt: Localized;
}

export interface ImageBlock {
  type: "image";
  image: ImageRef;
  caption: Localized;
}

/**
 * One premade card. Unlike the flashcard quiz, these are NOT dictionary senses (a kana,
 * a conjugation row, a counter) — authored front/back pairs that live in the lesson.
 */
export interface LessonCard {
  /** Shown first, in the learning language (あ). Read aloud. */
  front: string;
  /** The answer (a). Plain text. */
  back: string;
  /** Extra line on the back ("as in 'father'"), native language. */
  note: Localized;
  /** Optional picture on the FRONT (a mnemonic, a stroke diagram). */
  image: ImageRef | null;
  /**
   * The dictionary headword this card teaches, when `front` alone is ambiguous — a
   * lone kana word is (いえ analyses as the interjection "no"; `word: "家"` pins the
   * house). Null = look up `front`. Ignored when the deck's `lookup` is false.
   */
  word: string | null;
}

/**
 * An embedded practice deck: flip → "Got it" / "Again" (again re-queues the card at the
 * end), so a set like the あ-row is drilled to completion inside the page. Grading is
 * practice only — nothing is written to review_log; a card only reaches the vocabulary
 * when the user taps its ＋ (or "add all" at the end).
 */
export interface CardsBlock {
  type: "cards";
  title: Localized;
  cards: LessonCard[];
  /** Deal in random order (default true) — a fixed あいうえお order is recited, not recalled. */
  shuffle: boolean;
  /**
   * Resolve each card to a dictionary word (default true): a card that resolves gets the
   * flashcard quiz's ? info + ＋ add-to-list, and the finished deck offers "add all".
   * Set false for decks that aren't vocabulary (kana, conjugation rows) — otherwise あ
   * would offer to save the interjection "ah!".
   */
  lookup: boolean;
}

export type LessonBlock =
  | TextBlock
  | PatternBlock
  | ExampleBlock
  | ChoiceBlock
  | ImageBlock
  | CardsBlock;

export interface Lesson {
  id: string;
  schema: number;
  language: LangCode;
  level: string | null;
  title: Localized;
  blocks: LessonBlock[];
}

// ── Quizzes ─────────────────────────────────────────────────────────────────
// Standalone multiple-choice quizzes, published beside the lessons under
// `<LEARNING_LANG>/quizzes/` (index.json + content-addressed `<id>.<hash>.json`) and
// sharing the language folder's `images/`. Same contract as lessons: keyed on the
// pair, unknown fields ignored, a newer `schema` hidden from this build. A quiz's
// index is the same shape as the lessons' (LessonIndex / LessonSummary).

export type QuizOption = string | Localized;

/** One multiple-choice question. */
export interface QuizQuestion {
  /** The instruction, in the native language ("Which one is “o”?"). */
  prompt: Localized;
  /** Optional learning-language stem shown large (a word, a sentence with a ＿ blank). */
  text: string | null;
  image: ImageRef | null;
  /**
   * Answer choices. A plain string is learning-language text (あ, いえ); a Localized map
   * is an answer in the NATIVE language ({"EN": "house"}), picked like any prose — so
   * "what does this mean?" questions work for every native language.
   */
  options: QuizOption[];
  /** Index into `options` as AUTHORED (the page may display them shuffled). */
  answer: number;
  /** Shown after answering. */
  explanation: Localized;
}

export interface Quiz {
  id: string;
  schema: number;
  language: LangCode;
  level: string | null;
  title: Localized;
  questions: QuizQuestion[];
  /** Deal the questions in random order (default true). */
  shuffle: boolean;
  /** Show each question's options in random order (default true). */
  shuffleOptions: boolean;
}
