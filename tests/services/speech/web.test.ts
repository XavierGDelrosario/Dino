// The Web Speech backend's streaming contract. Two things decide whether this is a
// listener or a dictation box, and both are invisible in casual testing (someone
// talking constantly never hits either):
//   - it RESTARTS when Chrome ends the session on its own, which it does after a
//     few seconds of silence even with continuous = true — i.e. exactly when a
//     conversation pauses;
//   - a final utterance is emitted ONCE. The caller appends, so a repeat would
//     duplicate the line in the transcript.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webRecognizer } from "@/services/speech/providers/web";

// A stand-in for Chrome's SpeechRecognition: records what it was configured with
// and lets a test drive onresult/onerror/onend by hand.
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  started = false;
  stopped = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.stopped = true;
  }

  /** Deliver results the way the browser does: a growing list + a resultIndex. */
  emit(results: { text: string; final: boolean }[], resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: Object.assign(
        results.map((r) => Object.assign([{ transcript: r.text }], { isFinal: r.final, length: 1 })),
        { length: results.length },
      ),
    });
  }
}

const listen = async () => {
  const onPartial = vi.fn();
  const onFinal = vi.fn();
  const onError = vi.fn();
  const handle = await webRecognizer.startStream!({ lang: "JA", onPartial, onFinal, onError });
  return { onPartial, onFinal, onError, handle, live: () => FakeRecognition.instances[FakeRecognition.instances.length - 1] };
};

describe("webRecognizer (streaming)", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    (globalThis as unknown as { window: unknown }).window = {
      webkitSpeechRecognition: FakeRecognition,
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("configures a CONTINUOUS session with interim results", async () => {
    const { live } = await listen();
    expect(live().continuous).toBe(true);
    expect(live().interimResults).toBe(true);
    expect(live().lang).toBe("ja-JP");
    expect(live().started).toBe(true);
  });

  it("streams the forming utterance, then commits it once", async () => {
    const { onPartial, onFinal, live } = await listen();
    live().emit([{ text: "こんにち", final: false }]);
    expect(onPartial).toHaveBeenLastCalledWith("こんにち");
    expect(onFinal).not.toHaveBeenCalled();

    live().emit([{ text: "こんにちは", final: true }]);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("こんにちは");
    // The in-flight line clears, so the partial doesn't linger under the final.
    expect(onPartial).toHaveBeenLastCalledWith("");
  });

  it("does not re-emit finals it already reported", async () => {
    const { onFinal, live } = await listen();
    live().emit([{ text: "一つ目", final: true }], 0);
    // The browser keeps earlier results in the list; resultIndex says what's new.
    live().emit([{ text: "一つ目", final: true }, { text: "二つ目", final: true }], 1);
    expect(onFinal.mock.calls.flat()).toEqual(["一つ目", "二つ目"]);
  });

  it("RESTARTS when the browser ends the session — silence must not end listening", async () => {
    const { live } = await listen();
    const first = live();
    first.onend?.();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(live().started).toBe(true);
  });

  it("restarts through no-speech, which fires on any quiet stretch", async () => {
    const { onError, live } = await listen();
    live().onerror?.({ error: "no-speech" });
    live().onend?.();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled(); // not a failure the user should see
  });

  it("STOPS on a permission error instead of looping the prompt", async () => {
    const { onError, live } = await listen();
    live().onerror?.({ error: "not-allowed" });
    live().onend?.();
    expect(FakeRecognition.instances).toHaveLength(1); // no restart
    expect(onError).toHaveBeenCalledWith("not-allowed");
  });

  it("stop() ends the session and prevents the restart", async () => {
    const { handle, live } = await listen();
    const session = live();
    handle.stop();
    expect(session.stopped).toBe(true);
    session.onend?.();
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("is unavailable when the browser has no SpeechRecognition", () => {
    (globalThis as unknown as { window: unknown }).window = {};
    expect(webRecognizer.available()).toBe(false);
  });
});
