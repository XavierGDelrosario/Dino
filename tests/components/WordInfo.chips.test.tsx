// @vitest-environment jsdom
// The "?" panel shows each value on a rounded rectangle in ITS OWN colour: the level's
// chart colour, a point on the common → rare ramp, and a part-of-speech colour.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { WordInfo } from "@/components/common/WordInfo";

afterEach(cleanup);

const chips = (word: Parameters<typeof WordInfo>[0]["word"]) => {
  const { container } = render(
    <LocaleProvider>
      <WordInfo word={word} />
    </LocaleProvider>,
  );
  return [...container.querySelectorAll<HTMLElement>(".wordinfo-chip")].map((c) => ({
    text: c.textContent,
    color: c.style.getPropertyValue("--chip"),
  }));
};

describe("WordInfo — value chips", () => {
  it("colours the level, the commonness and the part of speech", () => {
    const out = chips({ sourceLang: "JA", proficiencyBand: 1, partOfSpeech: ["n"], frequency: 600 });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ text: "N5", color: "var(--lvl-1)" });
    expect(out[1].color).toContain("var(--ord-common)"); // the charts' own ramp
    expect(out[2]).toEqual({ text: "noun", color: "var(--pos-noun)" });
  });

  it("an unknown value is plain text — no empty rectangle", () => {
    expect(chips({ sourceLang: "JA", proficiencyBand: null, partOfSpeech: null, frequency: null })).toEqual([]);
  });

  it("the grammatical categories share one colour", () => {
    const particle = chips({ sourceLang: "JA", proficiencyBand: null, partOfSpeech: ["prt"], frequency: null });
    const conj = chips({ sourceLang: "JA", proficiencyBand: null, partOfSpeech: ["conj"], frequency: null });
    expect(particle[0].color).toBe("var(--pos-grammar)");
    expect(conj[0].color).toBe("var(--pos-grammar)");
  });
});
