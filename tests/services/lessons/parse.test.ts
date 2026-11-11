import { describe, it, expect, vi } from "vitest";
import {
  parseLesson,
  parseLessonIndex,
  pickLocalized,
  groupLessonsByLevel,
  lessonAssetUrl,
  LessonFormatError,
  LESSON_SCHEMA,
} from "@/services/lessons";

const base = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "hiragana-a-row",
  language: "ja",
  level: "N5",
  title: { EN: "Hiragana" },
  blocks,
  ...extra,
});

describe("parseLesson", () => {
  it("parses every block type and upper-cases language/locale keys", () => {
    const l = parseLesson(
      base([
        { type: "text", body: { en: "Hello" } },
        { type: "pattern", pattern: "N は N です" },
        { type: "example", text: "あい", gloss: { EN: "love" } },
        { type: "image", image: "images/a.png", caption: { EN: "chart" } },
        { type: "cards", cards: [{ front: "あ", back: "a", image: { src: "images/a.png", alt: { EN: "a" } } }] },
        { type: "choice", prompt: { EN: "o?" }, options: ["あ", "お"], answer: 1 },
      ]),
    );
    expect(l.language).toBe("JA");
    expect(l.blocks.map((b) => b.type)).toEqual(["text", "pattern", "example", "image", "cards", "choice"]);
    expect(l.blocks[0]).toEqual({ type: "text", body: { EN: "Hello" } });
    const cards = l.blocks[4];
    expect(cards.type === "cards" && cards.shuffle).toBe(true);
    expect(cards.type === "cards" && cards.cards[0].image?.src).toBe("images/a.png");
  });

  it("skips an unknown (newer) block type and keeps the rest — old builds degrade, never break", () => {
    const onIssue = vi.fn();
    const l = parseLesson(base([{ type: "audio", src: "x" }, { type: "text", body: { EN: "kept" } }]), { onIssue });
    expect(l.blocks).toHaveLength(1);
    expect(onIssue).toHaveBeenCalledOnce();
  });

  it("drops malformed blocks leniently but throws on them in strict mode (the publish script)", () => {
    const bad = base([{ type: "choice", prompt: { EN: "?" }, options: ["a", "b"], answer: 5 }]);
    expect(parseLesson(bad, { onIssue: () => {} }).blocks).toHaveLength(0);
    expect(() => parseLesson(bad, { strict: true })).toThrow(LessonFormatError);
  });

  it("only accepts image paths inside the folder's images/ — no URLs, no SVG", () => {
    for (const src of ["https://evil.example/x.png", "javascript:alert(1)", "../x.png", "images/x.svg", "images/a/b.png"]) {
      expect(parseLesson(base([{ type: "image", image: src }]), { onIssue: () => {} }).blocks).toHaveLength(0);
    }
  });

  it("rejects a lesson that needs a newer schema", () => {
    expect(() => parseLesson(base([], { schema: LESSON_SCHEMA + 1 }))).toThrow(/schema/);
  });

  it("rejects a file that isn't a lesson at all", () => {
    expect(() => parseLesson(null)).toThrow(LessonFormatError);
    expect(() => parseLesson(base([], { id: "Bad Id" }))).toThrow(/id/);
    expect(() => parseLesson(base([], { title: {} }))).toThrow(/title/);
  });
});

describe("parseLessonIndex", () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    file: `${id}.abc.json`,
    title: { EN: id },
    ...extra,
  });

  it("drops newer-schema, malformed and duplicate entries", () => {
    const idx = parseLessonIndex(
      {
        language: "JA",
        lessons: [entry("a"), entry("b", { schema: LESSON_SCHEMA + 1 }), entry("c", { file: "../x.json" }), entry("a")],
      },
      { onIssue: () => {} },
    );
    expect(idx.lessons.map((l) => l.id)).toEqual(["a"]);
  });

  it("throws without a lessons array", () => {
    expect(() => parseLessonIndex({ language: "JA" })).toThrow(LessonFormatError);
  });
});

describe("pickLocalized", () => {
  it("native language, then English, then whatever exists", () => {
    expect(pickLocalized({ EN: "e", KO: "k" }, "ko")).toBe("k");
    expect(pickLocalized({ EN: "e", JA: "j" }, "KO")).toBe("e");
    expect(pickLocalized({ JA: "j" }, "KO")).toBe("j");
    expect(pickLocalized({}, "EN")).toBe("");
  });
});

describe("groupLessonsByLevel", () => {
  const s = (id: string, level: string | null, order = 0) => ({
    id,
    file: `${id}.json`,
    schema: 1,
    level,
    order,
    title: { EN: id },
    summary: {},
  });

  it("orders by the language's framework (easiest first), then order; unknown levels last", () => {
    const g = groupLessonsByLevel([s("x", "N1"), s("b", "N5", 2), s("a", "N5", 1), s("z", null), s("q", "Z9")], "JA");
    expect(g.map((x) => x.level)).toEqual(["N5", "N1", null]);
    expect(g[0].lessons.map((l) => l.id)).toEqual(["a", "b"]);
    expect(g[2].lessons.map((l) => l.id).sort()).toEqual(["q", "z"]);
  });
});

describe("lessonAssetUrl", () => {
  it("builds a URL under the language folder", () => {
    expect(lessonAssetUrl("ja", "images/a.1.png", "https://x/lessons")).toBe("https://x/lessons/JA/images/a.1.png");
  });
});

describe("proseLanguages", () => {
  it("collects explanation languages, ignoring example glosses", async () => {
    const { proseLanguages } = await import("@/services/lessons");
    const glossOnly = parseLesson(base([{ type: "example", text: "あい", gloss: { EN: "love", JA: "愛" } }]));
    expect([...proseLanguages(glossOnly)]).toEqual(["EN"]); // the title only
    const both = parseLesson(base([{ type: "text", body: { EN: "x", JA: "y" } }]));
    expect(proseLanguages(both).has("JA")).toBe(true);
  });
});

describe("cards block word lookup", () => {
  it("defaults lookup on, keeps a pinned word, and honours lookup:false", () => {
    const l = parseLesson(
      base([
        { type: "cards", cards: [{ front: "いえ", word: "家", back: "house" }, { front: "あい", back: "love" }] },
        { type: "cards", lookup: false, cards: [{ front: "あ", back: "a" }] },
      ]),
    );
    const [vocab, kana] = l.blocks;
    expect(vocab.type === "cards" && vocab.lookup).toBe(true);
    expect(vocab.type === "cards" && vocab.cards.map((c) => c.word)).toEqual(["家", null]);
    expect(kana.type === "cards" && kana.lookup).toBe(false);
  });
});

describe("parseQuiz", () => {
  const quiz = (questions: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "kana-check",
    language: "ja",
    level: "N5",
    title: { EN: "Check" },
    questions,
    ...extra,
  });
  const good = { prompt: { EN: "Which is o?" }, options: ["あ", "お"], answer: 1 };

  it("parses questions with learning-language and native-language options", async () => {
    const { parseQuiz } = await import("@/services/lessons");
    const q = parseQuiz(
      quiz([good, { text: "いえ", prompt: { EN: "Meaning?" }, options: [{ EN: "house" }, { EN: "love" }], answer: 0 }]),
    );
    expect(q.language).toBe("JA");
    expect(q.questions).toHaveLength(2);
    expect(q.questions[1].options).toEqual([{ EN: "house" }, { EN: "love" }]);
    expect(q.shuffle && q.shuffleOptions).toBe(true);
  });

  it("drops a bad question leniently, throws in strict mode, and rejects an empty quiz", async () => {
    const { parseQuiz } = await import("@/services/lessons");
    const bad = { prompt: { EN: "?" }, options: ["a", "a"], answer: 0 }; // duplicate options
    expect(parseQuiz(quiz([good, bad]), { onIssue: () => {} }).questions).toHaveLength(1);
    expect(() => parseQuiz(quiz([good, bad]), { strict: true })).toThrow(LessonFormatError);
    expect(() => parseQuiz(quiz([bad]), { onIssue: () => {} })).toThrow(/no valid questions/);
  });
});
