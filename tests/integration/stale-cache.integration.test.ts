// =========================================================
// LIVE proof for the stale-projection gate (2026-07-13).
//
// `words` is a lazy cache. Every improvement to the projection bumps
// CURRENT_PROJECTION_VERSION, but until now NOTHING READ that stamp — a stale row was
// still a cache hit, so a fix only ever reached words nobody had looked up yet. On prod
// that meant ~4.7k of ~5k rows were stuck on versions 3–6, serving pre-fix projections
// (e.g. the old EN→JA sense order, i.e. the wrong primary meaning) forever.
//
// The fix: a stale row is a MISS, so the lookup re-projects it. The claims that need
// REAL Postgres + the REAL edge to prove — not a mock:
//   1. A stale row is not served; the word comes back correctly re-projected.
//   2. The row is UPDATED IN PLACE — same word_id — so a saved word's
//      user_words.dictionary_word_id keeps pointing at it (never orphaned/duplicated).
//      This is the whole reason the fix isn't "DELETE the stale rows".
//   3. An MT row (dictionary_ref = mt:…) is gated too, as of v8 — exempting it froze the
//      MT answer forever (接す stayed Google's "Contact" long after the dictionary could
//      resolve it). A stale MT row buys a FREE dictionary re-check: if the dictionary now
//      answers, it takes over; if not, the row we already paid for is revived (re-stamped
//      + served), so a version bump still never re-calls the PAID Google endpoint.
//
// PREREQUISITES:
//   1. supabase start
//   2. supabase functions serve translate --no-verify-jwt
//   3. JMdict ingested/seeded, and SUPABASE_SERVICE_ROLE_KEY set (it seeds `words`,
//      which clients may never write).
// =========================================================
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { URL, ANON, SERVICE_KEY, ENABLED, makeUser } from "./_support";
import { CURRENT_PROJECTION_VERSION } from "../../src/lib/projection";

const FN = `${URL}/functions/v1/translate`;
const RUN = ENABLED && Boolean(SERVICE_KEY);

let admin: SupabaseClient;
let hasDict = false;

async function translate(token: string, input: string, sourceLang = "JA", targetLang = "EN") {
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ input, sourceLang, targetLang }),
  });
  return { status: res.status, body: await res.json() };
}

async function rowsFor(input: string) {
  const { data } = await admin
    .from("words")
    .select("word_id, translation, projection_version, dictionary_ref, jmdict_sense_pos")
    .eq("input", input)
    .eq("source_lang", "JA")
    .eq("target_lang", "EN")
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });
  return data ?? [];
}

beforeAll(async () => {
  if (!RUN) return;
  admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  // Populate the cache for 猫 at the CURRENT version (needs JMdict present).
  const user = await makeUser();
  const { data } = await user.client.auth.getSession();
  const { body } = await translate(data.session!.access_token, "猫");
  hasDict = Boolean(body?.words?.length);
});

describe.skipIf(!RUN)("stale projections are re-projected, not served", () => {
  it("re-projects a stale row IN PLACE, keeping word_id (so saved words never dangle)", async () => {
    if (!hasDict) return; // JMdict not ingested in this environment
    const user = await makeUser();
    const { data: sess } = await user.client.auth.getSession();
    const token = sess.session!.access_token;

    const before = await rowsFor("猫");
    expect(before.length).toBeGreaterThan(0);
    const primary = before[0];

    // A user SAVES the word — user_words.dictionary_word_id now references this row.
    // Whatever the sweep does, this reference must survive.
    const { data: saved, error: saveErr } = await user.client.rpc("save_dictionary_word", {
      p_user_id: user.userId,
      p_dictionary_word_id: primary.word_id,
      p_list_id: null,
    });
    expect(saveErr).toBeNull();
    const savedRef = (saved as { dictionary_word_id: string }).dictionary_word_id;
    expect(savedRef).toBe(primary.word_id);

    // Now make the cache STALE, exactly as a version bump does: EVERY row of the word
    // drops below the current version at once (a bump is per-projection, not per-row).
    // The primary also gets a meaning the current logic would never produce, so a stale
    // HIT would be unmistakable in the response.
    await admin
      .from("words")
      .update({ projection_version: 3 })
      .eq("input", "猫")
      .eq("source_lang", "JA")
      .eq("target_lang", "EN");
    await admin
      .from("words")
      .update({ translation: "STALE-WRONG-MEANING" })
      .eq("word_id", primary.word_id);

    // Look it up again. Pre-fix this returned STALE-WRONG-MEANING (a cache hit).
    const { body } = await translate(token, "猫");

    expect(body.word.translation).not.toBe("STALE-WRONG-MEANING");
    expect(body.word.translation).toMatch(/cat/i);

    const after = await rowsFor("猫");
    const healed = after.find((r) => r.word_id === primary.word_id);
    expect(healed, "the row must be UPDATED IN PLACE, not replaced by a new row").toBeDefined();
    expect(healed!.translation).not.toBe("STALE-WRONG-MEANING");
    expect(healed!.projection_version).toBe(CURRENT_PROJECTION_VERSION);
    // No duplicate row forked off under a new word_id.
    expect(after.filter((r) => r.dictionary_ref === primary.dictionary_ref)).toHaveLength(1);

    // The user's saved word still points at the SAME row, and still has a meaning.
    const { data: uw } = await user.client
      .from("user_words")
      .select("dictionary_word_id, words(translation)")
      .eq("user_word_id", (saved as { user_word_id: string }).user_word_id)
      .single();
    expect(uw!.dictionary_word_id).toBe(primary.word_id);
    expect((uw!.words as unknown as { translation: string }).translation).toMatch(/cat/i);
  });

  // Seed an MT-cached row (dictionary_ref = mt:<input>) at an ancient version. Upsert,
  // not insert-after-delete: service_role deliberately has no DELETE grant on `words`
  // (the dictionary is server-write-only), so the seed must be idempotent.
  async function seedStaleMt(input: string, translation: string) {
    const { error } = await admin.from("words").upsert(
      {
        input,
        translation,
        source_lang: "JA",
        target_lang: "EN",
        is_verified: true,
        dictionary_ref: `mt:${input}`,
        projection_version: 1, // ancient → stale under the v8 gate
      },
      { onConflict: "dictionary_ref,source_lang,target_lang" },
    );
    expect(error).toBeNull();
  }

  it("REVIVES a stale MT row the dictionary still can't answer — never re-spends on Google", async () => {
    // The money-safety half of gating MT rows (v8). The word has no dictionary entry, so
    // the free re-check finds nothing; the row we ALREADY paid for is re-stamped current
    // and served as-is. Google is not called (locally it isn't even configured — a
    // fall-through would come back untranslated, which is exactly what must not happen).
    const user = await makeUser();
    const { data: sess } = await user.client.auth.getSession();
    const input = "ゼゼテスト";
    await seedStaleMt(input, "mt cached meaning");

    const { body } = await translate(sess.session!.access_token, input);

    expect(body.translated).toBe(true);
    expect(body.word?.translation).toBe("mt cached meaning");
    const [row] = await rowsFor(input);
    expect(row.projection_version).toBe(CURRENT_PROJECTION_VERSION); // revived, not re-bought
  });

  it("STOPS serving a stale MT row once the dictionary can answer (接す → 接する, not Google's gloss)", async () => {
    // The staleness half. 接す is kuromoji's lemma for 接して; JMdict only has 接する, so the
    // word used to fall through to MT and cache a bare "Contact" — which, while MT rows
    // were exempt from the gate, was then served FOREVER, even after the 〜す→〜する lemma
    // fallback taught the dictionary to resolve it. Now the stale MT row is a miss, the
    // dictionary answers, and the MT text is never served again.
    if (!hasDict) return; // JMdict not ingested in this environment
    const user = await makeUser();
    const { data: sess } = await user.client.auth.getSession();
    const input = "接す";
    await seedStaleMt(input, "Contact");

    const { body } = await translate(sess.session!.access_token, input);

    expect(body.word?.input).toBe("接する"); // the real headword…
    expect(body.word?.inputReading).toBe("せっする"); // …with its reading, which MT never had
    expect(body.word?.translation).toMatch(/to touch|to come in contact/i);
    expect(body.words?.some((w: { translation: string }) => w.translation === "Contact")).toBe(false);

    // The superseded MT row is left in place (a saved user_word may still reference it)
    // but stays below the current version, so it can never win a cache read again.
    const [mtRow] = await rowsFor(input);
    expect(mtRow.dictionary_ref).toBe(`mt:${input}`);
    expect(mtRow.projection_version).toBeLessThan(CURRENT_PROJECTION_VERSION);
  });
});
