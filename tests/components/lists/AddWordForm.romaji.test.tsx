// @vitest-environment jsdom
// Lists → Add word, with the source on Japanese: romaji is converted to kana before the
// lookup ("neko" → ねこ), exactly as Translate does. It used to go to the dictionary as
// Latin text and find nothing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

vi.mock("@/services/session", () => ({ getUserProfile: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/language")>()),
  dictionaryForm: vi.fn(async (s: string) => s), // no kuromoji needed here
}));

import { AddWordForm } from "@/components/lists/AddWordForm";

afterEach(cleanup);

function renderForm() {
  const lookup = vi.fn().mockResolvedValue({ input: "", meanings: [] });
  render(
    <LocaleProvider>
      <AddWordForm userId="u" lookup={lookup} onSaveSense={vi.fn()} onAddCustom={vi.fn()} onClose={vi.fn()} />
    </LocaleProvider>,
  );
  const lookUp = (word: string) => {
    fireEvent.change(screen.getByLabelText(/word to look up/i), { target: { value: word } });
    fireEvent.click(screen.getByRole("button", { name: /^translate$/i }));
  };
  return { lookup, lookUp };
}

describe("AddWordForm — romaji with a Japanese source", () => {
  it("looks up ねこ when you type neko", async () => {
    const { lookup, lookUp } = renderForm();
    lookUp("neko");
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(lookup.mock.calls[0][0]).toMatchObject({ input: "ねこ", sourceLang: "JA" });
  });

  it("leaves text that isn't whole romaji alone (cat, PDF)", async () => {
    const { lookup, lookUp } = renderForm();
    lookUp("PDF");
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(lookup.mock.calls[0][0].input).toBe("PDF");
  });
});
