// =========================================================
// DEV-ONLY mock recognizer — a scripted conversation on a timer.
//
// TEMPORARY. Exists so the live transcript can be developed and demoed without
// Chrome (the only browser that streams) and without talking out loud. It drives
// the REAL callbacks — partials that grow, then a final — so everything downstream
// runs exactly as it does with a microphone: append, analyze once, merge, render.
//
// Guarded by import.meta.env.DEV at every call site, so it is dead code in a
// production build. Delete this file when the native streaming provider lands.
//
// The script is ordinary written-by-hand Japanese, kept to common vocabulary so it
// colours in against the `-common-` JMdict subset a local stack runs.
// =========================================================

import type { SpeechStreamHandle, SpeechStreamOptions } from "../types";

/** A short everyday exchange — two people deciding to get coffee. */
const SCRIPT: readonly string[] = [
  "おはようございます。今日はいい天気ですね。",
  "そうですね。少し散歩に行きませんか。",
  "いいですね。でも、その前にコーヒーが飲みたいです。",
  "駅の近くに新しい喫茶店ができましたよ。",
  "本当ですか。じゃあ、そこに行きましょう。",
];

/** How fast the partial grows, and the gap before the next speaker starts. */
const CHUNK_MS = 140;
const CHARS_PER_CHUNK = 3;
const BETWEEN_LINES_MS = 900;

/**
 * Play the script through a stream's callbacks. Returns the same handle shape a
 * real recognizer does, so the caller can't tell the difference.
 */
export function mockConversation({ onPartial, onFinal }: SpeechStreamOptions): SpeechStreamHandle {
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const wait = (ms: number, fn: () => void) => {
    timers.push(setTimeout(fn, ms));
  };

  const speak = (index: number) => {
    if (stopped || index >= SCRIPT.length) return;
    const line = [...SCRIPT[index]]; // code points, so kanji never split mid-character
    let shown = 0;

    const grow = () => {
      if (stopped) return;
      shown = Math.min(line.length, shown + CHARS_PER_CHUNK);
      if (shown < line.length) {
        // A real recognizer rewrites the whole hypothesis each time, not just the
        // tail — that is why the caller must REPLACE the partial, never append.
        onPartial(line.slice(0, shown).join(""));
        wait(CHUNK_MS, grow);
        return;
      }
      onPartial("");
      onFinal(line.join(""));
      wait(BETWEEN_LINES_MS, () => speak(index + 1));
    };

    wait(CHUNK_MS, grow);
  };

  speak(0);

  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
