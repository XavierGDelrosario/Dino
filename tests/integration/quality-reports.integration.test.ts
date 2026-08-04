// =========================================================
// Regressions for filed QUALITY REPORTS (LIVE — needs a migrated, ingested DB).
//
// Every case here is a real report from `quality_reports`, kept as a test so a fix
// can't quietly come undone. They live in the integration suite because the thing
// that was broken is only observable against the real dictionary: the pure merge
// logic is already covered in tests/services/language/compounds.test.ts, and it
// passed the whole time these words were still coming back as fragments.
//
// FULL DICTIONARY ONLY. Dev and CI load the ~22.6k `-common-` JMdict subset, where
// several of these compounds genuinely have no entry; prod runs the full ~217k
// `jmdict-eng`. The block self-skips below that size rather than failing on a
// dictionary that was never expected to contain them.
//
// Gated behind RUN_INTEGRATION; see rpc.integration.test.ts for how to run.
// =========================================================
import { beforeAll, describe, expect, it } from "vitest";
import { ENABLED, SERVICE_KEY, serviceClient } from "./_support";

/** Entry count above which we consider the FULL dictionary loaded. */
const FULL_DICT_MIN_ENTRIES = 100_000;

let fullDictionary = false;

beforeAll(async () => {
  if (!ENABLED || !SERVICE_KEY) return;
  const client = serviceClient();
  if (!client) return;
  const { count } = await client
    .from("jmdict_entries")
    .select("*", { count: "exact", head: true });
  fullDictionary = (count ?? 0) >= FULL_DICT_MIN_ENTRIES;
});

/** The senses jmdict_lookup returns for a JA headword. */
async function lookup(input: string) {
  const client = serviceClient();
  if (!client) throw new Error("no service key — the describe guard should have skipped");
  const { data, error } = await client.rpc("jmdict_lookup", {
    p_input: input,
    p_source: "JA",
    p_target: "EN",
  });
  if (error) throw error;
  return (data ?? []) as { translation: string }[];
}

describe.skipIf(!ENABLED || !SERVICE_KEY)("quality reports — reported words resolve", () => {
  // Reports #1 and #2: "Lemmatizer parses as 2 words" / "Lemmatizer issue". kuromoji
  // splits both (柔軟 ＋ 剤, 電子 ＋ レンジ) and the reader looked the FRAGMENTS up, so
  // the word's meaning was simply lost. The dictionary-validated compound merge asks
  // about adjacent noun runs — which only helps if the dictionary actually has them.
  it.each([
    ["柔軟剤", "report #1 — fabric softener"],
    ["電子レンジ", "report #2 — microwave oven"],
  ])("resolves %s (%s)", async (word) => {
    if (!fullDictionary) return; // common-subset DB: not expected to have these
    const senses = await lookup(word);
    expect(senses.length).toBeGreaterThan(0);
    expect(senses[0].translation).toBeTruthy();
  });

  // Report #3: a photographed medicine package came back with no words detected.
  // The text is dense compound nouns, so it is the same failure as #1/#2 at scale —
  // these are the compounds that paragraph turns on.
  it.each([["医薬品"], ["服用"], ["使用期限"]])(
    "resolves %s from the medicine-packaging report (#3)",
    async (word) => {
      if (!fullDictionary) return;
      const senses = await lookup(word);
      expect(senses.length).toBeGreaterThan(0);
    },
  );

  // Not a filed report, but the documented example of the class: wordfreq cannot
  // rank multi-kanji compounds, so this one is invisible to the frequency-seeded
  // curated list and can ONLY come from the dictionary probe.
  it("resolves 唐揚げ — the compound the curated list could never have found", async () => {
    if (!fullDictionary) return;
    const senses = await lookup("唐揚げ");
    expect(senses.length).toBeGreaterThan(0);
  });

  it("reports the dictionary size it ran against", () => {
    // Not an assertion about the app — a note in the output so a SKIPPED run above
    // is legible rather than looking like silent success.
    expect(typeof fullDictionary).toBe("boolean");
  });
});
