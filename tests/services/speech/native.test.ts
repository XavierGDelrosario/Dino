// The NATIVE backend's streaming contract. Same two properties that decide whether
// this is a listener or a dictation box as on web, but reached differently:
//   - the plugin has no "final" event, so the utterance boundary is iOS ending the
//     session at a pause — the last partial at that moment is the finished line;
//   - it must RESTART after that, or the transcript dies the first time anyone
//     stops speaking.
// Neither shows up in casual testing, where someone talks continuously.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const start = vi.fn();
const stop = vi.fn();
const addListener = vi.fn();

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
const isListening = vi.fn();

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    available: () => Promise.resolve({ available: true }),
    checkPermissions: () => Promise.resolve({ speechRecognition: "granted" }),
    requestPermissions: () => Promise.resolve({ speechRecognition: "granted" }),
    start: (...a: unknown[]) => start(...a),
    stop: (...a: unknown[]) => stop(...a),
    isListening: () => isListening(),
    addListener: (...a: unknown[]) => addListener(...a),
  },
}));

import { nativeRecognizer } from "@/services/speech/providers/native";

// Captures the listeners the provider registers so a test can fire plugin events.
type Listeners = {
  partialResults?: (data: { matches: string[] }) => void;
  listeningState?: (data: { status: "started" | "stopped" }) => void;
};

// Streams opened by a test, torn down after it. Without this, a pending restart
// (which deliberately waits before calling start again) lands during a LATER test
// and inflates its call counts — and the health interval keeps ticking for ever.
const open: { stop: () => void }[] = [];

async function listen() {
  const listeners: Listeners = {};
  const removed: string[] = [];
  addListener.mockImplementation((event: keyof Listeners, fn: never) => {
    listeners[event] = fn;
    return Promise.resolve({ remove: () => void removed.push(event) });
  });
  const onPartial = vi.fn();
  const onFinal = vi.fn();
  const onError = vi.fn();
  const handle = await nativeRecognizer.startStream!({ lang: "JA", onPartial, onFinal, onError });
  open.push(handle);
  return { listeners, removed, onPartial, onFinal, onError, handle };
}

describe("nativeRecognizer (streaming)", () => {
  beforeEach(() => {
    start.mockReset().mockResolvedValue({});
    stop.mockReset().mockResolvedValue(undefined);
    isListening.mockReset().mockResolvedValue({ listening: true });
    addListener.mockReset();
  });

  afterEach(() => {
    open.forEach((h) => h.stop());
    open.length = 0;
  });

  it("asks the plugin for PARTIAL results in the right language", async () => {
    await listen();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({
      language: "ja-JP",
      partialResults: true,
      popup: false, // Android: a system dialog would take over the screen
    });
  });

  it("streams the utterance as it forms", async () => {
    const { listeners, onPartial, onFinal } = await listen();
    listeners.partialResults?.({ matches: ["こんにち"] });
    expect(onPartial).toHaveBeenLastCalledWith("こんにち");
    expect(onFinal).not.toHaveBeenCalled(); // nothing is committed mid-utterance
  });

  it("commits the last partial when the session ENDS — there is no final event", async () => {
    const { listeners, onPartial, onFinal } = await listen();
    listeners.partialResults?.({ matches: ["こんにちは"] });
    listeners.listeningState?.({ status: "stopped" });
    await Promise.resolve();
    expect(onFinal).toHaveBeenCalledWith("こんにちは");
    expect(onPartial).toHaveBeenLastCalledWith(""); // the forming line clears
  });

  it("RESTARTS a session that has ended — otherwise the transcript dies there", async () => {
    const { listeners } = await listen();
    listeners.listeningState?.({ status: "stopped" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("does not commit an empty utterance when nothing was said", async () => {
    const { listeners, onFinal } = await listen();
    listeners.listeningState?.({ status: "stopped" });
    await Promise.resolve();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("stop() keeps the half-said line, ends the session, and blocks the restart", async () => {
    const { listeners, handle, onFinal, removed } = await listen();
    listeners.partialResults?.({ matches: ["途中まで"] });
    handle.stop();

    expect(onFinal).toHaveBeenCalledWith("途中まで"); // not dropped
    expect(stop).toHaveBeenCalled();
    // Our own listeners are removed — NOT removeAllListeners(), which would tear
    // down anything else in the app listening to this plugin.
    expect(removed).toEqual(["partialResults", "listeningState"]);

    listeners.listeningState?.({ status: "stopped" });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1); // no restart after an explicit stop
  });

  // The boundary CANNOT depend on listeningState alone: on device iOS ends a
  // dictation session on silence without raising it, so every one of the tests
  // above passed while the real transcript never committed a single line. Silence
  // is therefore measured here, from the gap between partials.
  describe("silence boundary (self-detected)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** Let the async boundary (stop → restart) settle under fake timers. */
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it("commits the utterance after a silent gap, with no listeningState event", async () => {
      const { listeners, onFinal, onPartial } = await listen();
      listeners.partialResults?.({ matches: ["こんにちは"] });
      expect(onFinal).not.toHaveBeenCalled(); // still speaking

      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenCalledWith("こんにちは");
      expect(onPartial).toHaveBeenLastCalledWith("");
    });

    // THE CRASH: stopping and restarting the recognizer at every pause tears down
    // AVAudioEngine under a task that is still finishing, and the native exception
    // kills the app. A pause must end the LINE, never the session.
    it("does NOT stop or restart the recognizer at a pause", async () => {
      const { listeners, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["おはよう"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenCalledWith("おはよう"); // the line still lands
      expect(stop).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1); // same session, still listening
    });

    // iOS keeps ONE hypothesis running across a pause, so the next partial arrives
    // with the committed sentence still prefixed to it.
    it("strips what is already committed, so a sentence is not re-emitted", async () => {
      const { listeners, onPartial, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["おはよう"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenLastCalledWith("おはよう");

      // Same session, hypothesis grows: "おはよう" + the new sentence.
      listeners.partialResults?.({ matches: ["おはようございます今日はいい天気"] });
      expect(onPartial).toHaveBeenLastCalledWith("ございます今日はいい天気");
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenLastCalledWith("ございます今日はいい天気");
      expect(onFinal).toHaveBeenCalledTimes(2); // not three, and no duplicate text
    });

    // THE "IT SAID EVERYTHING TWICE" BUG. iOS ends its task after about a minute, so
    // a restart is routine, not rare — and the dying task flushes its whole
    // hypothesis as it closes. `restart` has already cleared `committed` by then, so
    // that flush used to read as brand-new speech: the entire previous session was
    // appended a second time and committed by the silence timer.
    it("ignores the dying session's flush during a restart — it is not new speech", async () => {
      const { listeners, onFinal, onPartial } = await listen();
      listeners.partialResults?.({ matches: ["さっき言ったこと"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenLastCalledWith("さっき言ったこと");

      // The session ends; `restart` runs synchronously as far as its first await, so
      // the teardown window is open from here.
      listeners.listeningState?.({ status: "stopped" });
      onPartial.mockClear();

      // …and in that window the closing task flushes everything it heard.
      listeners.partialResults?.({ matches: ["さっき言ったこと"] });
      expect(onPartial).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(onFinal).toHaveBeenCalledTimes(1); // committed once, not twice
    });

    // iOS rewrites earlier words as more audio arrives (kana converted to kanji, a
    // particle appearing), so the committed text is not always a literal prefix of
    // the hypothesis containing it. Taking the WHOLE hypothesis in that case — what
    // it used to do — handed back every line already on screen.
    it("does not re-emit committed text when the engine REVISES it", async () => {
      const { listeners, onPartial, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["きしゃのきしゃ"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenLastCalledWith("きしゃのきしゃ");

      // Converted to kanji: not a prefix any more, and SHORTER than the kana was.
      listeners.partialResults?.({ matches: ["汽車の記者が来た"] });
      const calls = onPartial.mock.calls;
      const emitted = calls[calls.length - 1][0] as string;

      // The property that matters: what comes back is a TAIL. Because kana→kanji
      // changes the character count, the seam is off by that delta (here "が来" is
      // lost with it) — the accepted cost of never repeating a paragraph. The box is
      // editable, which is why losing a character beats saying everything twice.
      expect("汽車の記者が来た".endsWith(emitted)).toBe(true);
      expect(emitted).not.toContain("汽車の記者");
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenCalledTimes(2);
    });

    it("treats a SHORTER hypothesis as a fresh one rather than swallowing it", async () => {
      const { listeners, onPartial, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["ながいはなしをしました"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(onFinal).toHaveBeenCalledTimes(1);

      // The engine started over: too short to be a continuation of the committed text.
      listeners.partialResults?.({ matches: ["はい"] });
      expect(onPartial).toHaveBeenLastCalledWith("はい");
    });

    it("restarts a session that died quietly — with a gap between stop and start", async () => {
      const { listeners } = await listen();
      listeners.partialResults?.({ matches: ["まだ聞こえる"] });
      isListening.mockResolvedValue({ listening: false }); // iOS ended the task

      await vi.advanceTimersByTimeAsync(5000); // health check fires
      await flush();
      await vi.advanceTimersByTimeAsync(500); // the deliberate restart delay
      await flush();
      expect(start).toHaveBeenCalledTimes(2);
    });

    it("leaves a HEALTHY session alone at the health check", async () => {
      await listen();
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(stop).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("each new partial pushes the boundary out — a pause mid-sentence is not a line break", async () => {
      const { listeners, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["きょうは"] });
      await vi.advanceTimersByTimeAsync(1000); // thinking…
      listeners.partialResults?.({ matches: ["きょうはいい天気"] });
      await vi.advanceTimersByTimeAsync(1000); // …still under the threshold
      expect(onFinal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600); // now the gap is long enough
      await flush();
      expect(onFinal).toHaveBeenCalledTimes(1);
      expect(onFinal).toHaveBeenCalledWith("きょうはいい天気");
    });

    it("does not fire the boundary twice when listeningState arrives as well", async () => {
      const { listeners, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["ありがとう"] });
      listeners.listeningState?.({ status: "stopped" });
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(onFinal).toHaveBeenCalledTimes(1);
    });

    it("stop() disarms the timer — no commit or restart after the user leaves", async () => {
      const { listeners, handle, onFinal } = await listen();
      listeners.partialResults?.({ matches: ["さようなら"] });
      handle.stop();
      onFinal.mockClear();

      await vi.advanceTimersByTimeAsync(5000);
      await flush();
      expect(onFinal).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it("is a no-op for a language the recognizer has no locale for", async () => {
    const handle = await nativeRecognizer.startStream!({
      lang: "XX",
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
    });
    expect(start).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });
});
