// @vitest-environment jsdom
// Hook spec for useDictation — the mic writing into the translate input box.
//
// The contract that matters is what is COMMITTED versus what is merely showing. A
// partial is a guess the recognizer is still revising; only a finalized utterance
// is text the user owns. Getting that wrong in either direction is bad in a way
// casual testing misses: commit too eagerly and half-heard fragments pile up in the
// box, commit too late and the last thing said before pressing stop is lost.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SpeechStreamOptions, SpeechStreamHandle } from "@/services/speech/types";

const startSpeechStream = vi.fn();
const isSpeechStreamAvailable = vi.fn();

vi.mock("@/services/speech", () => ({
  isSpeechStreamAvailable: (...a: unknown[]) => isSpeechStreamAvailable(...a),
  startSpeechStream: (...a: unknown[]) => startSpeechStream(...a),
  SpeechPermissionError: class SpeechPermissionError extends Error {},
}));

import { useDictation } from "@/hooks/useDictation";

/** A recognizer the test drives by hand, standing in for a real backend. */
function fakeRecognizer() {
  let opts: SpeechStreamOptions | null = null;
  const stop = vi.fn();
  startSpeechStream.mockImplementation((o: SpeechStreamOptions) => {
    opts = o;
    return Promise.resolve({ stop } as SpeechStreamHandle);
  });
  return {
    stop,
    partial: (text: string) => act(() => opts!.onPartial(text)),
    final: (text: string) => act(() => opts!.onFinal(text)),
    /** Backends commit the half-said line as they close — see native.test.ts. */
    stopCommitting: (text: string) => {
      stop.mockImplementation(() => opts!.onFinal(text));
    },
  };
}

/** Render the hook over a box the test can read back, as the view would. */
function box(initial = "") {
  let value = initial;
  const view = renderHook(
    ({ v }) =>
      useDictation({
        lang: "JA",
        value: v,
        onChange: (next) => {
          value = next;
          view.rerender({ v: next });
        },
      }),
    { initialProps: { v: initial } },
  );
  return { view, read: () => value };
}

beforeEach(() => {
  startSpeechStream.mockReset();
  isSpeechStreamAvailable.mockReset().mockResolvedValue(true);
});

describe("useDictation", () => {
  it("shows a forming utterance WITHOUT committing it", async () => {
    const mic = fakeRecognizer();
    const { view, read } = box();
    await act(async () => view.result.current.toggle());

    mic.partial("こんにち");
    expect(read()).toBe("こんにち");

    mic.partial("こんにちは"); // revised, not appended
    expect(read()).toBe("こんにちは");
  });

  it("commits a finalized utterance and starts the next one on its own line", async () => {
    const mic = fakeRecognizer();
    const { view, read } = box();
    await act(async () => view.result.current.toggle());

    mic.partial("こんにち");
    mic.final("こんにちは");
    mic.partial("げんき");

    // The committed line is fixed; the new partial forms after it, not inside it.
    expect(read()).toBe("こんにちは\nげんき");
  });

  it("DROPS a partial that never finalized when the session stops", async () => {
    // It was a guess the recognizer was still revising — leaving it in the box
    // would read as finished text the user had accepted.
    const mic = fakeRecognizer();
    const { view, read } = box();
    await act(async () => view.result.current.toggle());

    mic.final("こんにちは");
    mic.partial("まだ途中");
    act(() => view.result.current.toggle()); // stop

    expect(read()).toBe("こんにちは\n");
    expect(mic.stop).toHaveBeenCalled();
  });

  it("KEEPS the half-said line when the backend commits it on stop", async () => {
    // The native backend does exactly this, so stopping mid-sentence must not lose
    // what was already said.
    const mic = fakeRecognizer();
    const { view, read } = box();
    await act(async () => view.result.current.toggle());
    mic.stopCommitting("途中まで");

    mic.partial("途中まで");
    act(() => view.result.current.toggle());

    expect(read()).toBe("途中まで\n");
  });

  it("continues from text ALREADY in the box instead of replacing it", async () => {
    const mic = fakeRecognizer();
    const { view, read } = box("先に書いた文");
    await act(async () => view.result.current.toggle());

    mic.final("話した文");

    expect(read()).toBe("先に書いた文\n話した文\n");
  });

  it("reports a recognizer failure and stops listening", async () => {
    let opts: SpeechStreamOptions | null = null;
    startSpeechStream.mockImplementation((o: SpeechStreamOptions) => {
      opts = o;
      return Promise.resolve({ stop: vi.fn() });
    });
    const { view } = box();
    await act(async () => view.result.current.toggle());
    expect(view.result.current.listening).toBe(true);

    act(() => opts!.onError!("no-speech"));

    expect(view.result.current.error).toBe("no-speech");
    expect(view.result.current.listening).toBe(false);
  });

  it("opens ONE recognizer when the mic is pressed twice before it starts", async () => {
    // `handle` is only set after the await, so it can't guard the gap by itself. Two
    // sessions feeding the same box commit every utterance twice — and the first,
    // handle-less one keeps the mic open with no way to stop it.
    let release: ((h: SpeechStreamHandle) => void) | null = null;
    const stop = vi.fn();
    startSpeechStream.mockImplementation(
      () => new Promise<SpeechStreamHandle>((resolve) => (release = resolve)),
    );

    const { view } = box();
    await act(async () => {
      void view.result.current.toggle();
      void view.result.current.toggle(); // pressed again while the first is starting
    });
    expect(startSpeechStream).toHaveBeenCalledTimes(1);

    await act(async () => release!({ stop }));
    expect(view.result.current.listening).toBe(true);
  });

  it("stops the session when the screen goes away — the mic must not stay open", async () => {
    const mic = fakeRecognizer();
    const { view } = box();
    await act(async () => view.result.current.toggle());

    view.unmount();

    expect(mic.stop).toHaveBeenCalled();
  });
});
