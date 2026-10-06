// @vitest-environment jsdom
// Two controls on the Translate tab's boxes:
//  · the picture button is ONE button that asks "Take photo or Select photo?" — the
//    photo library no longer has a button of its own;
//  · the output box's flag files a quality report carrying the input AND the output.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const translate = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const capturePhoto = vi.hoisted(() => vi.fn());
const reportQualityIssue = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useTranslate", () => ({ useTranslate: () => translate.value }));
vi.mock("@/hooks/useLiveReader", () => ({
  useLiveReader: () => ({ para: null, analyzed: "", setComposing: () => {}, translateSentence: async () => {} }),
}));
vi.mock("@/hooks/useDictation", () => ({
  useDictation: () => ({ available: false, listening: false, committed: "", error: null, toggle: () => {}, startMock: () => {} }),
}));
vi.mock("@/services/ocr", () => ({
  isOcrAvailable: async () => true,
  capturePhoto,
  recognizeText: async () => "",
}));
vi.mock("@/services/handwriting", () => ({ isHandwritingAvailable: async () => false }));
vi.mock("@/services/photos/access", () => ({ photoAccess: async () => "full" }));
vi.mock("@/services/quality", () => ({ reportQualityIssue, REPORT_MAX_CHARS: 500 }));

import { TranslateView } from "@/views/TranslateView";

const base = () => ({
  source: "JA", target: "EN", learning: "JA",
  setSource: () => {}, setTarget: () => {}, swap: () => {},
  input: "", setInput: () => {}, output: "", status: "idle", mode: "word",
  meanings: [], para: null, headword: "", error: null,
  history: [], replayHistory: () => {}, clearHistory: () => {},
  lists: [], saved: new Set(), confidence: new Map(),
  addableCount: 0, reviewableCount: 0, addablePrimaries: [], addableCards: [], reviewablePrimaries: [],
  readerLoading: false, glossLoading: false, analyzedInput: "", contextByWord: new Map(),
  submit: async () => {}, syncSenseState: async () => {}, addWords: async () => {},
  createNamedList: async () => "l", softenSenses: async () => {}, applyReview: () => {},
  loadGloss: async () => {}, loadSentenceGloss: async () => {},
});

const view = () =>
  render(
    <LocaleProvider>
      <TranslateView userId="u" />
    </LocaleProvider>,
  );

beforeEach(() => {
  translate.value = base();
  capturePhoto.mockReset().mockResolvedValue(null);
  reportQualityIssue.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("TranslateView — the picture button", () => {
  const camera = () => screen.findByRole("button", { name: "Scan text from a photo" });

  it("is one button; pressing it offers Take photo / Select photo without opening anything", async () => {
    view();
    fireEvent.click(await camera());
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Take photo", "Select photo"]);
    expect(capturePhoto).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /saved image/ })).toBeNull();
  });

  it("Take photo opens the camera, Select photo the library, and either closes the menu", async () => {
    view();
    fireEvent.click(await camera());
    fireEvent.click(screen.getByRole("menuitem", { name: "Take photo" }));
    await waitFor(() => expect(capturePhoto).toHaveBeenCalledWith({ source: "camera" }));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(await camera());
    fireEvent.click(screen.getByRole("menuitem", { name: "Select photo" }));
    await waitFor(() => expect(capturePhoto).toHaveBeenLastCalledWith({ source: "library" }));
  });

  it("a press elsewhere puts the menu away", async () => {
    view();
    fireEvent.click(await camera());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("TranslateView — the output box's report flag", () => {
  const flag = () => screen.queryByRole("button", { name: "Report a problem with this translation" });

  it("is absent until there is a translation", () => {
    view();
    expect(flag()).toBeNull();
  });

  it("files the input together with the output", async () => {
    translate.value = { ...base(), input: "猫が走った。", output: "The cat ran.", status: "done", mode: "paragraph" };
    view();
    fireEvent.click(flag()!);
    // A note is required: Send is dead until something is written.
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "What's wrong with it?" }), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "What's wrong with it?" }), { target: { value: "wrong tense" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(reportQualityIssue).toHaveBeenCalledWith(
        expect.objectContaining({ input: "猫が走った。", output: "The cat ran.", description: "wrong tense" }),
      ),
    );
  });

  it("copy is second in both boxes: under the ✕ on the input, under the flag on the output", () => {
    translate.value = { ...base(), input: "猫が走った。", output: "The cat ran.", status: "done", mode: "paragraph" };
    const { container } = view();
    const names = (sel: string) =>
      [...container.querySelectorAll(`${sel} > button`)].slice(0, 2).map((b) => b.getAttribute("aria-label"));
    expect(names(".io__tools")).toEqual(["Clear input", "Copy"]);
    expect(names(".io__copy")).toEqual(["Report a problem with this translation", "Copy"]);
  });
});
