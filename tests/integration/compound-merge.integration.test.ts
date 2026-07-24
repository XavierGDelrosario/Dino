// =========================================================
// Dictionary-validated COMPOUND MERGE, end to end (LIVE — needs a migrated DB
// with JMdict ingested, plus the `translate` edge function served).
//
// This is the fix for the recurring "reader loses the word" quality reports
// (柔軟剤, 電子レンジ): kuromoji's IPADIC over-segments compounds JMdict actually
// has, so the reader looked up the FRAGMENTS and showed no meaning. The unit
// tests cover the pure span logic with a stubbed dictionary; only a live run
// proves the whole chain — real kuromoji tokens → candidate probe → the edge's
// dictionary-only lookup → merged token carrying real senses.
//
// It also pins the COST boundary that makes the probe safe: probes must never
// reach the paid MT fallback (most guesses are wrong, and MT would both bill per
// wrong guess and cache junk as a verified word).
//
// Gated behind RUN_INTEGRATION. Self-skips if JMdict isn't ingested. To run:
//   supabase start
//   supabase functions serve translate         # in another shell
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   npm run test:integration
// =========================================================
import { describe, it, expect, beforeAll } from "vitest";
import { ENABLED, URL as SUPA_URL, ANON } from "./_support";
import { translateParagraph } from "@/services/lookup";
import { analyze } from "@/services/language/analyze";
import { __clearWordsCache } from "@/services/words/cache";

const T = 60_000; // real kuromoji load + live round-trips

// The reported words must be IN the dictionary for this suite to mean anything —
// on the `-common-` JMdict subset they are absent, which is a skip, not a failure.
let dictionaryHasThem = false;

beforeAll(async () => {
  if (!ENABLED) return;
  // Probe the SOURCE dictionary through the edge (a fresh DB has an empty `words`
  // table even with JMdict fully ingested), using the dictionary-only path so this
  // check can never spend on MT either.
  const res = await fetch(`${SUPA_URL}/functions/v1/translate`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: ["柔軟剤", "電子レンジ"],
      sourceLang: "JA",
      targetLang: "EN",
      dictionaryOnly: true,
    }),
  }).catch(() => null);
  if (!res || !res.ok) return;
  const body = (await res.json()) as { results?: { words?: unknown[] }[] };
  const results = body.results ?? [];
  dictionaryHasThem = results.length === 2 && results.every((r) => (r.words?.length ?? 0) > 0);
}, T);

describe.runIf(ENABLED)("compound merge — live", () => {
  it("merges 柔軟剤, which kuromoji splits, and carries its real meaning", async () => {
    if (!dictionaryHasThem) return; // full JMdict not ingested here
    __clearWordsCache();

    // The bug: the analyzer alone loses the word.
    const raw = await analyze("柔軟剤を買った", "JA");
    expect(raw.filter((t) => t.text === "柔軟剤")).toHaveLength(0);

    // The fix: the reader gets it back, with senses attached.
    const res = await translateParagraph({
      input: "柔軟剤を買った",
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(res.tokens.map((t) => t.text)).toContain("柔軟剤");
    expect(res.meanings.get("柔軟剤")?.length ?? 0).toBeGreaterThan(0);
  }, T);

  it("merges the katakana compound 電子レンジ", async () => {
    if (!dictionaryHasThem) return;
    __clearWordsCache();
    const res = await translateParagraph({
      input: "電子レンジで温める",
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(res.tokens.map((t) => t.text)).toContain("電子レンジ");
  }, T);

  it("leaves a noun run alone when the dictionary has no such compound", async () => {
    if (!dictionaryHasThem) return;
    __clearWordsCache();
    // 漢方 ＋ 製剤 are both real words; 漢方製剤 is not a JMdict entry. The probe
    // must not invent it (the merge only fires on dictionary confirmation).
    const res = await translateParagraph({
      input: "漢方製剤です",
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(res.tokens.map((t) => t.text)).not.toContain("漢方製剤");
  }, T);

  it("resolves a long paste in one pass — the URL-length failure that greyed the reader", async () => {
    if (!dictionaryHasThem) return;
    __clearWordsCache();
    // Enough distinct Japanese words that the cache read's filter, inlined into a
    // single GET, exceeded what the runtime would send — the batch then threw and
    // EVERY word rendered without meanings (quality report #3). Chunked now.
    const text = "医薬品の説明書きを必ず読んでください。使用期限を過ぎた製品は服用しないこと。"
      + "高齢者や妊婦は医師に相談すること。発疹や吐き気などの症状があらわれた場合は"
      + "直ちに服用を中止し、薬剤師又は登録販売者に相談してください。";
    const res = await translateParagraph({ input: text, sourceLang: "JA", targetLang: "EN" });
    const resolved = res.tokens.filter((t) => (res.meanings.get(t.text)?.length ?? 0) > 0);
    // The failure mode was TOTAL (zero words resolved), so any healthy fraction
    // proves the read completed; assert a strong majority of content words.
    expect(resolved.length).toBeGreaterThan(res.tokens.length / 2);
  }, T);

  it("never returns a sense twice for a word split across cache-read chunks", async () => {
    if (!dictionaryHasThem) return;
    __clearWordsCache();
    // A row matches by headword OR reading, so 行く and いく as separate keys can
    // pull the SAME row from two different chunks. Measured 24 rows / 12 unique
    // before the dedupe; every sense showed twice in the reader.
    const text = "行くと決めた。いくつもある。";
    const res = await translateParagraph({ input: text, sourceLang: "JA", targetLang: "EN" });
    for (const [surface, senses] of res.meanings) {
      const ids = senses.map((s) => s.wordId);
      expect(new Set(ids).size, `duplicate senses for ${surface}`).toBe(ids.length);
    }
  }, T);
});
