// =========================================================
// Pure, runtime-agnostic helpers for the `translate` edge function.
//
// Extracted so they can be UNIT-TESTED from the Node/Vitest suite — the edge
// function itself runs in Deno and imports supabase-js by URL, so it can't be
// imported into Vitest, and its top-level Deno.serve() would start a server on
// import. Nothing here touches Deno, Request, env, or the network; index.ts does
// all the I/O and calls these. Deno imports this as "./_lib.ts"; the Vitest spec
// imports it as "../../supabase/functions/translate/_lib".
// =========================================================

/** One projected sense: translation + optional per-side readings + JMdict identity. */
export interface ProviderResult {
  translation: string;
  inputReading?: string | null;
  translationReading?: string | null;
  // JA->EN: the canonical JA headword (kanji if the entry has one, else kana) to
  // store as `input`. null/undefined → use the search term as-is (EN->JA, MT).
  headword?: string | null;
  // STABLE JMdict source identity (null for MT). JA->EN: sensePos = sense index;
  // EN->JA: the match rank (informational).
  entryId?: string | null;
  sensePos?: number | null;
  // Difficulty axis: corpus-frequency rank (lower = more common; null for MT).
  frequency?: number | null;
  // Proficiency-label axis: the headword's curated band (JLPT/CEFR; null for MT
  // or words the wordlist lacks). Ascending = harder. See services/proficiency.
  proficiencyBand?: number | null;
  // POS tags of the sense (null for MT).
  partOfSpeech?: string[] | null;
}

/** A `words` row ready for upsert (snake_case, matches the table). */
export interface WordRowInsert {
  input: string;
  translation: string;
  source_lang: string;
  target_lang: string;
  input_reading: string | null;
  translation_reading: string | null;
  part_of_speech: string[] | null;
  frequency: number | null;
  // Curated proficiency band (JLPT/CEFR) of the headword; null when the wordlist
  // lacks it or for MT rows. Projected from jmdict_lookup, like frequency.
  proficiency_band: number | null;
  // Always null from projection — the NORMALIZED 1..5 difficulty override is a
  // separate axis, unset today. Listed so the upsert row shape matches the table.
  difficulty_override: number | null;
  jmdict_entry_id: string | null;
  jmdict_sense_pos: number | null;
  dictionary_ref: string;
  projection_version: number;
  is_verified: boolean;
}

// App language codes are uppercase short codes (JA/EN/KO/ZH); Google v2 wants
// ISO-639-1 lowercase. Split-script Chinese maps to its regional code.
export function toGoogleLang(lang: string): string {
  const code = lang.trim().toLowerCase();
  switch (code) {
    case "zh-hans":
      return "zh-CN";
    case "zh-hant":
      return "zh-TW";
    default:
      return code; // ja, en, ko, zh, …
  }
}

/**
 * The caller's user id from the request JWT's `sub` (signature verified upstream
 * by the gateway). null for the bare anon key / unauthenticated / malformed token
 * → callers fall back to default limits. Handles base64url (no-padding) payloads.
 */
export function userIdFromAuth(authHeader: string | null): string | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * CORS headers for a request Origin against an allow-list. Empty list → "*"
 * (dev convenience). Non-empty → echo the Origin if it's listed, else grant none
 * ("null", a non-usable value). NOTE: the local `supabase start` Kong gateway
 * rewrites this to "*"; the function's value is authoritative only in production.
 */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: string[],
): Record<string, string> {
  const allowOrigin = allowedOrigins.length === 0
    ? "*"
    : allowedOrigins.includes(origin ?? "")
      ? (origin as string)
      : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/** Parse a comma-separated ALLOWED_ORIGINS env value into a trimmed list. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Learn / calibration request (level-based new-words quiz) ────────────────
/** Default / max words per learn (or calibration) round. Bounded so one request
 *  can't fan out a huge batch projection. */
export const DEFAULT_LEARN_LIMIT = 10;
export const MAX_LEARN_LIMIT = 30;

/** Validated learn-request params, or an error message for a bad band. */
export type ParsedLearn =
  | { ok: true; band: number; limit: number; excludeSeen: boolean }
  | { ok: false; error: string };

/**
 * Validate + normalize a `{ band, limit?, excludeSeen? }` learn request:
 *   - band  — must be an INTEGER 1..6 (the framework ordinal); anything else errors.
 *   - limit — clamped to [1, MAX_LEARN_LIMIT]; a missing/NaN/≤0 value → DEFAULT.
 *   - excludeSeen — defaults TRUE (the learn quiz wants only NEW words); only the
 *     calibration caller passes false to sample the whole band.
 */
export function parseLearnRequest(
  learn: { band?: unknown; limit?: unknown; excludeSeen?: unknown },
): ParsedLearn {
  const band = Number(learn.band);
  if (!Number.isInteger(band) || band < 1 || band > 6) {
    return { ok: false, error: "learn.band must be an integer 1..6" };
  }
  const limit = Math.min(
    Math.max(Math.trunc(Number(learn.limit)) || DEFAULT_LEARN_LIMIT, 1),
    MAX_LEARN_LIMIT,
  );
  const excludeSeen = learn.excludeSeen !== false;
  return { ok: true, band, limit, excludeSeen };
}

/**
 * Resolve the service-role key the edge client authenticates with. Prefers an
 * explicit SERVICE_ROLE_SECRET (a new `sb_secret_…` key, set when legacy API keys
 * are disabled) over the auto-injected legacy SUPABASE_SERVICE_ROLE_KEY. Uses
 * truthiness (not `??`) so an EMPTY-STRING secret (an easy misconfig) falls back to
 * the legacy key instead of being used as a blank, broken credential. Returns
 * undefined only when neither is set (a real misconfiguration).
 */
export function resolveServiceKey(
  env: { SERVICE_ROLE_SECRET?: string | null; SUPABASE_SERVICE_ROLE_KEY?: string | null },
): string | undefined {
  return env.SERVICE_ROLE_SECRET?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
}

/**
 * Project provider results into verified `words` rows. Stores the canonical
 * headword (kanji writing for JA->EN) as `input` so a kana search keeps the kanji.
 * DEDUPEs by (headword, translation): JMdict can yield several senses aggregating
 * to the SAME string (私 → "I; me" twice) — keep the first. Distinct translations
 * carry distinct dictionary_refs, so the dedupe also prevents a duplicate
 * onConflict key (a single ON CONFLICT can't update one row twice — Postgres
 * 21000). The STABLE dictionary_ref pins a row to its SOURCE sense, not the
 * mutable headword, so a re-projection UPDATEs in place instead of forking:
 *   MT (no entry):       'mt:<input>'
 *   JA-source (headword): '<entry>:<pos>'   (headword is a projection output)
 *   EN-source (no head):  '<input>:<entry>' (input is the stable search term)
 */
export function projectRows(
  results: ProviderResult[],
  input: string,
  sourceLang: string,
  targetLang: string,
  projectionVersion: number,
): WordRowInsert[] {
  const seen = new Set<string>();
  const rows: WordRowInsert[] = [];
  for (const r of results) {
    const head = r.headword ?? input;
    const key = `${head} ${r.translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = r.entryId == null
      ? `mt:${input}`
      : r.headword != null
        ? `${r.entryId}:${r.sensePos ?? 0}`
        : `${input}:${r.entryId}`;
    rows.push({
      input: head,
      translation: r.translation,
      source_lang: sourceLang,
      target_lang: targetLang,
      input_reading: r.inputReading ?? null,
      translation_reading: r.translationReading ?? null,
      part_of_speech: r.partOfSpeech ?? null,
      frequency: r.frequency ?? null,
      proficiency_band: r.proficiencyBand ?? null,
      difficulty_override: null,
      jmdict_entry_id: r.entryId ?? null,
      jmdict_sense_pos: r.sensePos ?? null,
      dictionary_ref: ref,
      projection_version: projectionVersion,
      is_verified: true,
    });
  }
  return rows;
}

/**
 * BATCH projection: project several inputs' results into one flat upsert list,
 * de-duped GLOBALLY by dictionary_ref. The cross-input dedupe matters because a
 * single `INSERT … ON CONFLICT` can't touch the same conflict key twice — if two
 * search terms in the batch resolve to the SAME JMdict sense (e.g. a kanji and
 * its kana both present), keeping one row avoids Postgres 21000. Which input
 * "owns" the row for the response is resolved separately by groupByInput (which
 * matches headword/reading), so dropping the duplicate here loses nothing.
 */
export function projectMany(
  perInput: { input: string; results: ProviderResult[] }[],
  sourceLang: string,
  targetLang: string,
  projectionVersion: number,
): WordRowInsert[] {
  const seenRef = new Set<string>();
  const rows: WordRowInsert[] = [];
  for (const { input, results } of perInput) {
    for (const row of projectRows(results, input, sourceLang, targetLang, projectionVersion)) {
      if (seenRef.has(row.dictionary_ref)) continue;
      seenRef.add(row.dictionary_ref);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Override a per-input attribute on every result with the value keyed by the
 * LOWERCASED input, or NULL when the input isn't in the map — never leaving the
 * matched translation's value. Pure; the DB read that builds `bySurface` stays in
 * the edge I/O shell. Used by the EN->JA overrides (english_frequency /
 * english_proficiency) so an English headword carries its OWN corpus frequency /
 * CEFR band, not the JA translation's JLPT/JA value.
 */
export function applyInputAttributeOverride(
  perInput: { input: string; results: ProviderResult[] }[],
  bySurface: Map<string, number>,
  attr: "frequency" | "proficiencyBand",
): void {
  for (const p of perInput) {
    const v = bySurface.get(p.input.toLowerCase()) ?? null; // input's own value, or NULL
    for (const r of p.results) {
      if (attr === "frequency") r.frequency = v;
      else r.proficiencyBand = v;
    }
  }
}

/**
 * Merge two ordered provider-result lists into one, PRIMARY first, deduped by
 * jmdict_entry_id, capped at `limit`. Used by the EN->JA path: WordNet's
 * synset-grouped results lead (higher quality, sense-disambiguated), and the
 * reverse-gloss jmdict_lookup results fill any remaining slots (coverage for
 * English words WordNet lacks / extra senses it missed). A result already present
 * by entryId is dropped (same JMdict entry → same `words` row / dictionary_ref).
 *
 * sensePos is RE-NUMBERED to the merged index so the order survives the cache read
 * (fetchVerified orders by jmdict_sense_pos). Safe for EN->JA: there sensePos is a
 * display RANK, not a JMdict sense index, and is NOT part of the dictionary_ref
 * ('<input>:<entry>'), so renumbering doesn't change a row's identity.
 */
export function mergeProviderResults(
  primary: ProviderResult[],
  fallback: ProviderResult[],
  limit: number,
): ProviderResult[] {
  const seen = new Set<string>();
  const merged: ProviderResult[] = [];
  for (const r of [...primary, ...fallback]) {
    if (merged.length >= limit) break;
    const key = r.entryId ?? null;
    if (key != null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(r);
  }
  return merged.map((r, i) => ({ ...r, sensePos: i }));
}

// ── Per-language lookup seams ──────────────────────────────────────────────
// Each language brings its OWN input/output concerns (EN: plural/tense lemmatization;
// JA: kana/kanji output; ZH: Han; KO: Hangul). These two registries keep that knowledge
// PLUGGABLE — adding a language is a new map/switch entry, NOT a new hard-coded branch
// in resolveDictionary. Mirrors the client-side language/registry.ts + senses/difficulty
// seams (the edge runs in Deno and can't import those, so it keeps its own copy here).

// OUTPUT guard, keyed on TARGET language → the script a result's `translation` MUST
// contain to be a real word in that language. A reverse-gloss lookup can drag in
// off-script noise (romaji ＰＥＮ/ＢＩＳ for a JA target); drop it. A target with no
// entry (e.g. EN) imposes no constraint → identity pass.
const TARGET_SCRIPT: Record<string, RegExp> = {
  JA: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  // ZH: /\p{Script=Han}/u,
  // KO: /[\p{Script=Hangul}\p{Script=Han}]/u,
};

/**
 * Drop results whose `translation` isn't in the TARGET language's script. Real
 * loanwords are stored in-script (JA katakana ペン → kept); romaji/initialism noise
 * (ＰＥＮ, ＢＩＳ that a gloss merely MENTIONS) is removed. No-op for targets without a
 * TARGET_SCRIPT entry. Mirrors the reader's no-Japanese-script rule for QR/URL.
 */
export function dropOffScriptTranslations(
  results: ProviderResult[],
  targetLang: string,
): ProviderResult[] {
  const script = TARGET_SCRIPT[targetLang.toUpperCase()];
  return script ? results.filter((r) => script.test(r.translation)) : results;
}

// Irregular English inflections the regular detachment rules below can't derive —
// strong-verb past/participles + irregular plurals. Common forms only; the long tail
// lives in Princeton WordNet's verb.exc/noun.exc (the eventual ingest upgrade). A key
// that is ALSO a valid lemma (saw, rose, left, felt) is harmless: resolveDictionary
// tries the SURFACE form first, so the direct sense wins before this map is consulted.
const EN_IRREGULARS: Record<string, string> = {
  // be / have / do
  was: "be", were: "be", been: "be", am: "be", are: "be", is: "be",
  had: "have", has: "have", did: "do", does: "do", done: "do",
  // high-frequency strong verbs (past, past participle → base)
  went: "go", gone: "go", got: "get", gotten: "get", made: "make", knew: "know",
  known: "know", thought: "think", took: "take", taken: "take", saw: "see",
  seen: "see", came: "come", gave: "give", given: "give", found: "find",
  told: "tell", became: "become", left: "leave", felt: "feel", brought: "bring",
  began: "begin", begun: "begin", kept: "keep", held: "hold", wrote: "write",
  written: "write", stood: "stand", heard: "hear", meant: "mean", met: "meet",
  ran: "run", paid: "pay", sat: "sit", spoke: "speak", spoken: "speak", led: "lead",
  grew: "grow", grown: "grow", lost: "lose", fell: "fall", fallen: "fall",
  sent: "send", built: "build", understood: "understand", drew: "draw",
  drawn: "draw", broke: "break", broken: "break", spent: "spend", rose: "rise",
  risen: "rise", drove: "drive", driven: "drive", bought: "buy", wore: "wear",
  worn: "wear", chose: "choose", chosen: "choose", sought: "seek", threw: "throw",
  thrown: "throw", caught: "catch", dealt: "deal", won: "win", forgot: "forget",
  forgotten: "forget", ate: "eat", eaten: "eat", taught: "teach", sold: "sell",
  flew: "fly", flown: "fly", fought: "fight", hid: "hide", hidden: "hide",
  // irregular plurals (plural → singular)
  men: "man", women: "woman", children: "child", people: "person", feet: "foot",
  teeth: "tooth", geese: "goose", mice: "mouse", oxen: "ox",
};

// morphy-style regular detachment rules: each yields candidate base forms by suffix.
// Over-generates on purpose — the WordNet lookup VERIFIES each candidate, so a bogus
// one (e.g. "buses"→"buse") simply returns no rows and is skipped.
function regularLemmaCandidates(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (s.length >= 2 && s !== w) out.push(s); };
  if (w.endsWith("ies") && w.length > 4) add(w.slice(0, -3) + "y"); // studies→study
  if (w.endsWith("ied") && w.length > 4) add(w.slice(0, -3) + "y"); // studied→study
  if (w.endsWith("ves") && w.length > 3) { add(w.slice(0, -3) + "f"); add(w.slice(0, -3) + "fe"); } // leaves→leaf, knives→knife
  if (w.endsWith("es") && w.length > 3) add(w.slice(0, -2)); // boxes→box, goes→go
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 2) add(w.slice(0, -1)); // cats→cat
  if (w.endsWith("ing") && w.length > 4) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); } // walking→walk, making→make
  if (w.endsWith("ed") && w.length > 3) { add(w.slice(0, -2)); add(w.slice(0, -1)); } // walked→walk, liked→like
  if (w.endsWith("er") && w.length > 3) { add(w.slice(0, -2)); add(w.slice(0, -1)); } // smaller→small, larger→large
  if (w.endsWith("est") && w.length > 4) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); } // smallest→small, largest→large
  // Collapse a doubled final consonant before -ing/-ed/-er/-est (running→run, stopped→stop).
  for (const suf of ["ing", "ed", "er", "est"]) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const stem = w.slice(0, -suf.length);
      if (/([bcdfghjklmnpqrstvwxz])\1$/.test(stem)) add(stem.slice(0, -1));
    }
  }
  return out;
}

/**
 * Lemma candidates for a query, keyed on SOURCE language — the per-language input seam.
 * Returns the SURFACE form first (morphy tries it before lemmatizing), then ordered
 * base-form candidates. The caller looks each up IN ORDER and keeps the first that
 * resolves, so the dictionary itself verifies the lemma (no separate lemma index).
 *   EN — WordNet-morphy: irregular map + regular detachment rules. Covers cats→cat,
 *        ran→run, studies→study, running→run, mice→mouse. Long-tail irregulars are the
 *        Princeton verb.exc/noun.exc upgrade (see docs/TODO.md).
 *   other — identity ([input]); JA arrives pre-lemmatized from kuromoji.
 */
export function lemmaCandidates(input: string, sourceLang: string): string[] {
  if (sourceLang.toUpperCase() !== "EN") return [input];
  const w = input.toLowerCase();
  const cands = [input];
  const seen = new Set([w]);
  const push = (c: string) => {
    const k = c.toLowerCase();
    if (!seen.has(k)) { seen.add(k); cands.push(c); }
  };
  if (EN_IRREGULARS[w]) push(EN_IRREGULARS[w]);
  for (const c of regularLemmaCandidates(w)) push(c);
  return cands;
}

/**
 * BATCH lemmatization resolver — the paragraph/word-by-word counterpart of the
 * single-word candidate loop. Both WordNet and the gloss fallback are queried ONCE over
 * the UNION of every token's lemma candidates (`*ByCand` are keyed by candidate); this
 * picks each token's senses WITHOUT another round-trip:
 *   - winning lemma = the first of the token's candidates that WordNet resolves (after
 *     the off-script filter), else the surface form;
 *   - the gloss fallback uses THAT lemma;
 *   - results are re-keyed to the ORIGINAL token (the reader looks them up by surface).
 * Tokens with no senses are omitted. Mirrors single-word resolveDictionary exactly.
 */
export function resolvePerInputWithCandidates(
  inputs: string[],
  candsByInput: Map<string, string[]>,
  wnByCand: Map<string, ProviderResult[]>,
  glossByCand: Map<string, ProviderResult[]>,
  targetLang: string,
  limit: number,
): Map<string, ProviderResult[]> {
  const out = new Map<string, ProviderResult[]>();
  for (const input of inputs) {
    const cands = candsByInput.get(input) ?? [input];
    let wn: ProviderResult[] = [];
    let lemma = input;
    for (const c of cands) {
      const hit = dropOffScriptTranslations(wnByCand.get(c) ?? [], targetLang);
      if (hit.length > 0) { wn = hit; lemma = c; break; }
    }
    const gloss = dropOffScriptTranslations(glossByCand.get(lemma) ?? [], targetLang);
    const merged = mergeProviderResults(wn, gloss, limit);
    if (merged.length > 0) out.set(input, merged);
  }
  return out;
}

/**
 * Assign verified rows back to the SEARCH terms that asked for them, the same way
 * the single-word cache read matches: a row belongs to a term when the term equals
 * its stored headword (`input`) OR its reading (`input_reading`) — so a kana search
 * (ねこ) still collects its kanji-headword row (猫). Each term's rows come back
 * primary-sense first (jmdict_sense_pos asc, nulls last). A term with no match maps
 * to an empty array.
 */
export function groupByInput<
  T extends { input: string; input_reading: string | null; jmdict_sense_pos: number | null },
>(rows: T[], inputs: string[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const input of inputs) {
    const matched = rows
      .filter((r) => r.input === input || r.input_reading === input)
      .sort((a, b) => {
        const ap = a.jmdict_sense_pos, bp = b.jmdict_sense_pos;
        if (ap == null) return bp == null ? 0 : 1; // nulls last
        if (bp == null) return -1;
        return ap - bp;
      });
    out.set(input, matched);
  }
  return out;
}
