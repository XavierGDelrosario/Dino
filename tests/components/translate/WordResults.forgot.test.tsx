// @vitest-environment jsdom
// The "Forgot" control on the single-word lookup.
//
// It was the one saved-word readout in the app that stayed plain text ("✓ n/5") after
// the confidence dots BECAME the Forgot control everywhere else — so the surface a user
// is most likely looking at when they think "I don't actually know this" was the one
// surface with no way to say it. That's a gap a screenshot doesn't catch and a type
// doesn't either (`onForgot` is optional by design, for callers with nothing to wire),
// which is what this file is for.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { WordResults } from "@/components/translate/WordResults";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";
import type { Word } from "@/services/words/repository";
import { SOFTEN_MIN_CONFIDENCE } from "@/services/review";

const spicy = makeWord({ wordId: "w1", input: "辛い", translation: "spicy" });
const harsh = makeWord({ wordId: "w2", input: "辛い", translation: "harsh" });

const onForgot = vi.fn(async (_words: Word[]) => {});

function draw(saved: string[], confidence: [string, number][]) {
  return render(
    <LocaleProvider>
      <WordResults
        headword="辛い"
        meanings={[spicy, harsh]}
        saved={new Set(saved)}
        confidence={new Map(confidence)}
        lists={[]}
        userId="u"
        onAdd={async () => {}}
        onCreateList={async () => "l"}
        onForgot={onForgot}
      />
    </LocaleProvider>,
  );
}

const dots = () => screen.queryAllByRole("button", { name: /press to say you forgot/ });

afterEach(() => {
  onForgot.mockClear();
  cleanup();
});

describe("WordResults — Forgot", () => {
  it("offers it on a saved sense and on no other", () => {
    draw(["w1"], [["w1", 5]]);
    expect(dots()).toHaveLength(1);
  });

  it("asks before acting, then softens THAT sense alone", () => {
    // Per sense, not per word: the row shows one sense's own confidence, so the
    // control has to act on what it reads. (The reader's hovercard is headed by the
    // WORD and softens every sense of it — a different unit, deliberately.)
    draw(["w1", "w2"], [["w1", 5], ["w2", 5]]);

    fireEvent.click(dots()[0]);
    fireEvent.click(screen.getByRole("button", { name: "Forgot?" }));

    expect(onForgot).toHaveBeenCalledTimes(1);
    expect(onForgot.mock.calls[0][0]).toEqual([spicy]);
  });

  it("stays inert below the soften floor, where the server would no-op", () => {
    // A control that silently does nothing is worse than no control — same rule the
    // dots apply in Lists.
    draw(["w1"], [["w1", SOFTEN_MIN_CONFIDENCE - 1]]);
    expect(dots()).toHaveLength(0);
  });

  it("shows nothing for a sense that isn't saved yet", async () => {
    draw([], []);
    expect(dots()).toHaveLength(0);
    // …and the add button is what that row offers instead.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Add/ }).length).toBe(2));
  });
});
