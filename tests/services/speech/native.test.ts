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
vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    available: () => Promise.resolve({ available: true }),
    checkPermissions: () => Promise.resolve({ speechRecognition: "granted" }),
    requestPermissions: () => Promise.resolve({ speechRecognition: "granted" }),
    start: (...a: unknown[]) => start(...a),
    stop: (...a: unknown[]) => stop(...a),
    addListener: (...a: unknown[]) => addListener(...a),
  },
}));

import { nativeRecognizer } from "@/services/speech/providers/native";

// Captures the listeners the provider registers so a test can fire plugin events.
type Listeners = {
  partialResults?: (data: { matches: string[] }) => void;
  listeningState?: (data: { status: "started" | "stopped" }) => void;
};

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
  return { listeners, removed, onPartial, onFinal, onError, handle };
}

describe("nativeRecognizer (streaming)", () => {
  beforeEach(() => {
    start.mockReset().mockResolvedValue({});
    stop.mockReset().mockResolvedValue(undefined);
    addListener.mockReset();
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

  it("commits the last partial when the speaker pauses — there is no final event", async () => {
    const { listeners, onPartial, onFinal } = await listen();
    listeners.partialResults?.({ matches: ["こんにちは"] });
    listeners.listeningState?.({ status: "stopped" });
    expect(onFinal).toHaveBeenCalledWith("こんにちは");
    expect(onPartial).toHaveBeenLastCalledWith(""); // the forming line clears
  });

  it("RESTARTS after that pause — otherwise the transcript ends at the first silence", async () => {
    const { listeners } = await listen();
    listeners.listeningState?.({ status: "stopped" });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not commit an empty utterance when a pause brought no speech", async () => {
    const { listeners, onFinal } = await listen();
    listeners.listeningState?.({ status: "stopped" });
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

    it("restarts the session after committing, so the next utterance is heard", async () => {
      const { listeners } = await listen();
      listeners.partialResults?.({ matches: ["おはよう"] });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(stop).toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(2);
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
