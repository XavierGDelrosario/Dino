// @vitest-environment jsdom
// The shared listen button. Two host-protecting rules: it renders NOTHING when the
// platform can't pronounce the language (a dead button that plays silence reads as
// a broken app), and its click must not reach the surface underneath — it lives
// inside a flashcard that flips on click and a list row that selects on click.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const isVoiceAvailable = vi.fn();
const speak = vi.fn();
const cancelSpeech = vi.fn();

vi.mock("@/services/voice", () => ({
  isVoiceAvailable: (...a: unknown[]) => isVoiceAvailable(...a),
  speak: (...a: unknown[]) => speak(...a),
  cancelSpeech: () => cancelSpeech(),
}));

import { SpeakButton } from "@/components/common/SpeakButton";

function renderButton(props: { text: string; lang?: string }, onHostClick = vi.fn()) {
  // The host div stands in for a flashcard: clicking it flips the card.
  const r = render(
    <LocaleProvider>
      <div onClick={onHostClick} data-testid="host">
        <SpeakButton text={props.text} lang={props.lang ?? "JA"} />
      </div>
    </LocaleProvider>,
  );
  return { onHostClick, button: () => r.container.querySelector("button") };
}

describe("SpeakButton", () => {
  beforeEach(() => {
    isVoiceAvailable.mockResolvedValue(true);
    speak.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders nothing when the platform has no voice for the language", async () => {
    isVoiceAvailable.mockResolvedValue(false);
    const { button } = renderButton({ text: "ねこ" });
    // Give the availability check a tick to settle before asserting absence.
    await waitFor(() => expect(isVoiceAvailable).toHaveBeenCalled());
    expect(button()).toBeNull();
  });

  it("renders nothing for empty text", async () => {
    const { button } = renderButton({ text: "   " });
    await waitFor(() => expect(isVoiceAvailable).toHaveBeenCalled());
    expect(button()).toBeNull();
  });

  it("speaks the text in the word's language, without triggering the surface beneath", async () => {
    const { button, onHostClick } = renderButton({ text: "ねこ" });
    await waitFor(() => expect(button()).not.toBeNull());
    fireEvent.click(button()!);
    expect(speak).toHaveBeenCalledWith({ text: "ねこ", lang: "JA" });
    expect(onHostClick).not.toHaveBeenCalled(); // the card must not flip
  });

  it("a second tap stops playback instead of starting a second one", async () => {
    let end: () => void = () => {};
    speak.mockImplementation(() => new Promise<void>((r) => (end = r)));
    const { button } = renderButton({ text: "ねこ" });
    await waitFor(() => expect(button()).not.toBeNull());

    fireEvent.click(button()!); // start
    fireEvent.click(button()!); // stop
    expect(cancelSpeech).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    end();
  });
});
