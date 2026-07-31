// @vitest-environment jsdom
// The voice facade against a stubbed speechSynthesis. The properties worth pinning
// are the ones that decide whether a button appears at all (a device with no voice
// for the language must report unavailable, not play silence) and the queueing
// behaviour (speak REPLACES — the API's default is to queue, which would make a
// second tap play after the first instead of instead of it).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Utterance = { text: string; lang: string; voice?: unknown; onend?: () => void; onerror?: () => void };

const voices = (...langs: string[]) => langs.map((lang) => ({ lang, name: `voice-${lang}` }));

function installSynth(voiceList: { lang: string; name: string }[]) {
  const spoken: Utterance[] = [];
  const synth = {
    getVoices: () => voiceList,
    speak: vi.fn((u: Utterance) => {
      spoken.push(u);
      u.onend?.(); // resolve immediately — playback timing isn't what's under test
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      lang = "";
      voice: unknown;
      onend?: () => void;
      onerror?: () => void;
      constructor(text: string) {
        this.text = text;
      }
    },
  );
  return { synth, spoken };
}

describe("voice facade", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("is unavailable when the platform has no speechSynthesis at all", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    // jsdom defines the property, so remove it outright to model an older runtime.
    Reflect.deleteProperty(window, "speechSynthesis");
    const { isVoiceAvailable } = await import("@/services/voice");
    expect(await isVoiceAvailable()).toBe(false);
  });

  it("reports a language available only when a voice for it exists", async () => {
    installSynth(voices("ja-JP", "en-US"));
    const { isVoiceAvailable } = await import("@/services/voice");
    expect(await isVoiceAvailable("JA")).toBe(true);
    expect(await isVoiceAvailable("KO")).toBe(false); // no Korean voice installed
    expect(await isVoiceAvailable("XX")).toBe(false); // language we don't map
  });

  it("matches a same-language voice when the exact locale is missing", async () => {
    installSynth(voices("en-GB"));
    const { isVoiceAvailable } = await import("@/services/voice");
    expect(await isVoiceAvailable("EN")).toBe(true);
  });

  it("treats an EMPTY voice list as unknown, not unsupported", async () => {
    // The iOS WKWebView can report zero voices while speaking the language fine.
    // Saying "unsupported" there hides the listen button across the whole platform.
    installSynth([]);
    const { isVoiceAvailable } = await import("@/services/voice");
    expect(await isVoiceAvailable("JA")).toBe(true);
    expect(await isVoiceAvailable("XX")).toBe(false); // still no for an unmapped lang
  });

  it("speaks with the language's voice, and CANCELS first so taps replace rather than queue", async () => {
    const { synth, spoken } = installSynth(voices("ja-JP", "en-US"));
    const { speak } = await import("@/services/voice");
    await speak({ text: "ねこ", lang: "JA" });
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("ねこ");
    expect(spoken[0].voice).toMatchObject({ lang: "ja-JP" });
  });

  it("does not speak empty text", async () => {
    const { synth } = installSynth(voices("ja-JP"));
    const { speak } = await import("@/services/voice");
    await speak({ text: "   ", lang: "JA" });
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("resolves even when the utterance ERRORS — a stuck promise would freeze the button", async () => {
    const { synth } = installSynth(voices("ja-JP"));
    synth.speak.mockImplementation((u: Utterance) => u.onerror?.());
    const { speak } = await import("@/services/voice");
    await expect(speak({ text: "ねこ", lang: "JA" })).resolves.toBeUndefined();
  });

  it("cancelSpeech stops playback IN FLIGHT (and is a no-op when idle)", async () => {
    const { synth, spoken } = installSynth(voices("ja-JP"));
    // Hold the utterance open, and let cancel() end it — which is what a real
    // browser does (cancelling fires the utterance's `end`).
    synth.speak.mockImplementation((u: Utterance) => void spoken.push(u));
    synth.cancel.mockImplementation(() => spoken[spoken.length - 1]?.onend?.());

    const { speak, cancelSpeech } = await import("@/services/voice");
    expect(() => cancelSpeech()).not.toThrow(); // nothing playing yet

    const playing = speak({ text: "ねこ", lang: "JA" });
    await new Promise((r) => setTimeout(r, 0)); // let speak() reach the synth
    expect(spoken).toHaveLength(1);
    synth.cancel.mockClear();

    cancelSpeech();
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    await expect(playing).resolves.toBeUndefined(); // the pending speak resolves
  });
});
