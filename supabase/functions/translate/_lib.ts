// Pure, runtime-agnostic helpers for the `translate` edge function.
//
// Extracted so they can be UNIT-TESTED from Node/Vitest — index.ts itself runs in Deno,
// imports supabase-js by URL and starts a server at import. Nothing here touches Deno,
// Request, env or the network; index.ts does all the I/O and calls these.

/** One projected sense: translation + optional per-side readings + JMdict identity. */
export interface ProviderResult {
  translation: string;
  inputReading?: string | null;
  translationReading?: string | null;
  // JA->EN: the canonical JA headword to store as `input`. null → use the search
  // term as-is (EN->JA, MT).
  headword?: string | null;
  // STABLE JMdict identity (null for MT). JA->EN: sensePos = sense index;
  // EN->JA: the match rank (informational).
  entryId?: string | null;
  sensePos?: number | null;
  /** Corpus-frequency rank (lower = more common; null for MT). */
  frequency?: number | null;
  /** Curated band (JLPT/CEFR), ascending = harder. null for MT / unlisted words. */
  proficiencyBand?: number | null;
  partOfSpeech?: string[] | null;
  // Sense enrichment (20260750), stamped by applySenseExamples AFTER the provider
  // returns. JA→EN only — EN→JA's sensePos is a match rank, so nothing safe to key on.
  example?: string | null;
  exampleGloss?: string | null;
  definitionSource?: string | null;
  /** Pinned furigana for the target inside `example` (20260751). */
  exampleReading?: string | null;
  /** Curated display order; null → fall back to sensePos (never stored null). */
  senseRank?: number | null;
}

/**
 * The STABLE cache identity of a projected sense — `words.dictionary_ref`. Curation
 * keys on it too (20260752), so an override survives any change to sense ORDER.
 *   JA→EN  `<entryId>:<sensePos>` — free of the headword, which a projection change
 *          can move (the いく/行く problem, CLAUDE.md #1).
 *   EN→JA  `<input>:<entryId>` — sensePos here is a match RANK, so it identifies nothing.
 *   MT     `mt:<input>`.
 */
export function dictionaryRefFor(
  r: Pick<ProviderResult, "entryId" | "sensePos" | "headword">,
  input: string,
): string {
  if (r.entryId == null) return `mt:${input}`;
  return r.headword != null ? `${r.entryId}:${r.sensePos ?? 0}` : `${input}:${r.entryId}`;
}

/**
 * The key CURATION is stored under: the dictionary_ref, lowercased. The EN→JA ref
 * embeds the TYPED term, so `Car:1323080` and `car:1323080` are the same lookup.
 * Case-folding only the curation key leaves cache identity (which `user_words` and
 * the upsert depend on) untouched.
 */
export function curationKeyFor(ref: string): string {
  return ref.toLowerCase();
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
  proficiency_band: number | null;
  /** Always null from projection — a separate axis, unset today. Listed to match the table. */
  difficulty_override: number | null;
  jmdict_entry_id: string | null;
  jmdict_sense_pos: number | null;
  // Per-sense enrichment (20260750). NULL on every EN→JA and MT row.
  example: string | null;
  example_gloss: string | null;
  definition_source: string | null;
  example_reading: string | null;
  /** Display order. NEVER null — every read sorts on it; un-curated = jmdict_sense_pos. */
  sense_rank: number;
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
 * The caller's user id from the request JWT's `sub` (signature verified upstream by the
 * gateway). null for anon/malformed → callers fall back to default limits.
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
 * CORS headers for an Origin against an allow-list. Empty list → "*" (dev); otherwise
 * echo a listed Origin, else "null". NOTE: the local Kong gateway rewrites this to "*",
 * so the function's value is authoritative only in production.
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
/** Words per learn/calibration round. Bounded so one request can't fan out a huge batch. */
export const DEFAULT_LEARN_LIMIT = 10;
export const MAX_LEARN_LIMIT = 30;

/** Validated learn-request params, or an error message for a bad band. */
export type ParsedLearn =
  | { ok: true; band: number; limit: number; excludeSeen: boolean }
  | { ok: false; error: string };

/**
 * Validate + normalize a `{ band, limit?, excludeSeen? }` learn request. band must be an
 * integer 1..6 (the framework ordinal); limit clamps to [1, MAX]; excludeSeen defaults
 * TRUE (learn wants only NEW words) — only calibration passes false.
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

// ── SEGMENTS mode (the inline reader gloss) ────────────────────────────────
// A paragraph arrives pre-split into SENTENCES, each translated as its own unit so
// gloss[i] belongs to sentence[i] — splitting one blob of English back apart can't
// guarantee that, since MT merges and splits sentences.

/** Upper bound on sentences per request — a guard on fan-out, not a UX limit. */
export const MAX_SEGMENTS = 400;

export interface PreparedSegments {
  /** NFC-normalized text per REQUEST index; "" for a blank/non-string entry. */
  normalized: string[];
  /** The DISTINCT non-empty texts to translate, in first-appearance order. */
  unique: string[];
  /** For each request index, its position in `unique`, or -1 (nothing to send). */
  uniqueIndex: number[];
  /** Chars actually billed — the sum over `unique`, so repeats are free. */
  chars: number;
}

/**
 * Normalize + DEDUPE a segments request: only the distinct set is sent and billed
 * (subtitle tracks repeat lines heavily). Blanks keep their position but are never
 * sent. NFC like every input boundary — it also makes the dedupe see two spellings
 * of the same Japanese string as one.
 */
export function prepareSegments(raw: unknown[]): PreparedSegments {
  const normalized = raw.map((v) => (typeof v === "string" ? v.trim().normalize("NFC") : ""));
  const unique: string[] = [];
  const seen = new Map<string, number>();
  const uniqueIndex = normalized.map((text) => {
    if (!text) return -1;
    const hit = seen.get(text);
    if (hit !== undefined) return hit;
    seen.set(text, unique.length);
    unique.push(text);
    return unique.length - 1;
  });
  return { normalized, unique, uniqueIndex, chars: unique.reduce((n, t) => n + t.length, 0) };
}

/** Scatter provider results (one per `unique`) back onto the REQUEST indexes. */
export function expandSegmentResults(
  prepared: PreparedSegments,
  translated: (string | null)[] | null,
): (string | null)[] {
  if (!translated) return prepared.normalized.map(() => null);
  return prepared.uniqueIndex.map((u) => (u >= 0 ? translated[u] ?? null : null));
}

/**
 * The service-role key the edge client authenticates with. Prefers an explicit
 * SERVICE_ROLE_SECRET (`sb_secret_…`, set when legacy keys are disabled) over the
 * auto-injected legacy one. Truthiness, not `??`, so an EMPTY-STRING secret falls
 * back rather than being used as a blank credential.
 */
export function resolveServiceKey(
  env: { SERVICE_ROLE_SECRET?: string | null; SUPABASE_SERVICE_ROLE_KEY?: string | null },
): string | undefined {
  return env.SERVICE_ROLE_SECRET?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
}

/**
 * Project provider results into verified `words` rows. Stores the canonical headword as
 * `input` so a kana search keeps the kanji. DEDUPEs by (headword, translation): JMdict
 * can yield several senses aggregating to the SAME string (私 → "I; me" twice), and a
 * single ON CONFLICT can't update one row twice (Postgres 21000). See dictionaryRefFor.
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
    const ref = dictionaryRefFor(r, input);
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
      example: r.example ?? null,
      example_gloss: r.exampleGloss ?? null,
      definition_source: r.definitionSource ?? null,
      example_reading: r.exampleReading ?? null,
      sense_rank: r.senseRank ?? r.sensePos ?? 0,
      dictionary_ref: ref,
      projection_version: projectionVersion,
      is_verified: true,
    });
  }
  return rows;
}

/**
 * BATCH projection into one flat upsert list, de-duped GLOBALLY by dictionary_ref: two
 * search terms can resolve to the SAME sense (a kanji and its kana), and one ON CONFLICT
 * can't touch a key twice. groupByInput decides which input owns the row for the
 * response, so dropping the duplicate here loses nothing.
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
 * Override a per-input attribute with the value keyed by the LOWERCASED input, or NULL
 * when absent — never leaving the matched translation's value. Used by EN->JA so an
 * English headword carries its OWN frequency / CEFR band, not the JA translation's.
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
 * Merge the EN->JA providers into one list, deduped by jmdict_entry_id, capped at
 * `limit`. sensePos is RE-NUMBERED to the merged index so the order survives the cache
 * read (fetchVerified sorts on it) — safe here, since EN->JA sensePos is a display rank
 * and is not part of the dictionary_ref.
 */
export function mergeProviderResults(
  semantic: ProviderResult[],
  gloss: ProviderResult[],
  limit: number,
): ProviderResult[] {
  // INTERSECTION-BOOST, then GLOSS, then WordNet.
  //
  // An entry BOTH providers return is high-confidence, so it leads, ordered by GLOSS rank.
  // WordNet is LAST on purpose: it orders by PRINCETON sense rank, which ranks ENGLISH
  // senses and says nothing about which JA lemma of a synset is the right translation
  // (measured: 'run' → 言う·機能·運転 with 走る nowhere near the top). The gloss search
  // ranks by how PRIMARY the match is inside the entry (20260742's headline_rank), which
  // answers the actual question; WordNet covers what the gloss search misses entirely.
  const glossRank = new Map<string, number>();
  gloss.forEach((r, i) => { if (r.entryId != null && !glossRank.has(r.entryId)) glossRank.set(r.entryId, i); });
  const semanticIds = new Set(semantic.map((r) => r.entryId).filter((k): k is string => k != null));

  const shared = semantic
    .filter((r) => r.entryId != null && glossRank.has(r.entryId))
    .sort((a, b) => glossRank.get(a.entryId!)! - glossRank.get(b.entryId!)!);
  const semanticOnly = semantic.filter((r) => r.entryId == null || !glossRank.has(r.entryId));
  const glossOnly = gloss.filter((r) => r.entryId == null || !semanticIds.has(r.entryId));

  const seen = new Set<string>();
  const merged: ProviderResult[] = [];
  for (const r of [...shared, ...glossOnly, ...semanticOnly]) {
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
// Adding a language is a new map entry here, not a branch in resolveDictionary. The
// edge runs in Deno and can't import the client's language/ registry, hence the copy.

// OUTPUT guard, keyed on TARGET language → the script a `translation` must contain to
// be a real word in it. No entry (e.g. EN) → no constraint.
const TARGET_SCRIPT: Record<string, RegExp> = {
  JA: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  // ZH: /\p{Script=Han}/u,
  // KO: /[\p{Script=Hangul}\p{Script=Han}]/u,
};

/**
 * Drop results whose `translation` isn't in the TARGET script. Loanwords are stored
 * in-script (ペン kept); romaji/initialism noise a gloss merely MENTIONS (ＰＥＮ, ＢＩＳ)
 * is removed. No-op for targets without a TARGET_SCRIPT entry.
 */
export function dropOffScriptTranslations(
  results: ProviderResult[],
  targetLang: string,
): ProviderResult[] {
  const script = TARGET_SCRIPT[targetLang.toUpperCase()];
  return script ? results.filter((r) => script.test(r.translation)) : results;
}

// INPUT guard, keyed on SOURCE language → the script a WORD must contain to be a
// word in that language at all. Mirror of TARGET_SCRIPT, applied before we spend.
const SOURCE_SCRIPT: Record<string, RegExp> = {
  JA: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  EN: /[A-Za-z]/,
  // ZH: /\p{Script=Han}/u,
  // KO: /[\p{Script=Hangul}\p{Script=Han}]/u,
};

/**
 * Is this token not worth paying MT for? Word-level ONLY — never apply it to the
 * paragraph gloss, whose segments are sentences, not vocabulary.
 *
 * Two classes decidable for free before the call, both of which prod was billing for:
 * no letter anywhere (page numbers, phone numbers, OCR blobs) and off-script for the
 * source language (Latin words submitted as JA, which Google mistranslated into noise).
 * The dictionary path runs first and is unaffected — a skipped token returns "no result"
 * and the reader greys it out, which is correct for a page number.
 */
export function shouldSkipMt(input: string, sourceLang: string): boolean {
  const text = input.trim();
  if (!text) return true;
  if (!/\p{L}/u.test(text)) return true; // digits / punctuation / symbols only
  const script = SOURCE_SCRIPT[sourceLang.toUpperCase()];
  return script ? !script.test(text) : false;
}

/**
 * Did MT hand back what we sent it? Google echoes input it can't translate, and caching
 * that mints a "verified" row whose meaning is the word itself. Case- and
 * width-insensitive, so `URL` → `ＵＲＬ` counts. The chars are already spent by now:
 * this is a CACHE-POISONING guard, not a cost one (that's shouldSkipMt).
 */
export function isEchoTranslation(input: string, translation: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
  return norm(input) === norm(translation);
}

// Irregular English inflections the detachment rules below can't derive. Common forms
// only; the long tail is Princeton WordNet's verb.exc/noun.exc (a future ingest). A key
// that is also a valid lemma (saw, rose, left) is harmless — the SURFACE is tried first.
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

// morphy-style detachment rules → candidate base forms by suffix. Over-generates on
// purpose: the lookup VERIFIES each candidate, so a bogus one returns no rows.
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
 * JA lemma candidates: the surface, then its する-verb form when it ends in す.
 *
 * IPADIC files the stem of a する-verb under a 五段・サ行 lemma ending in す (接して →
 * 接す) but JMdict's headword is 接する, so the lemma missed the dictionary and fell
 * through to paid MT. The surface is tried FIRST, so genuine 五段 〜す verbs (出す, 話す)
 * still resolve to themselves and a bogus candidate (出する) returns no rows.
 */
function jaSuruCandidates(input: string): string[] {
  if (input.length < 2 || !input.endsWith("す")) return [input];
  return [input, `${input.slice(0, -1)}する`];
}

// 五段 potential stem (え-row) → the う-row char its dictionary form ends in.
const JA_POTENTIAL_STEM: Record<string, string> = {
  え: "う", け: "く", げ: "ぐ", せ: "す", て: "つ",
  ね: "ぬ", へ: "ふ", べ: "ぶ", め: "む", れ: "る",
};

/**
 * The DICTIONARY form of a potential verb ("can ~"), or null. IPADIC lexicalizes the
 * potential form (帰れる) as its own entry, which JMdict has no headword for, so it fell
 * through to paid MT. 五段: strip the え-row stem + る, restore the う-row ending
 * (帰れる → 帰る). 一段: 〜られる → 〜る.
 *
 * A 一段 verb is indistinguishable from a 五段 potential by surface, so 食べる
 * speculatively offers 食ぶ — harmless, since this is consulted only AFTER the surface
 * misses. する → できる is absent: not derivable from the surface.
 */
function jaPotentialCandidate(input: string): string | null {
  if (input.length < 3 || !input.endsWith("る")) return null;
  if (input.length >= 4 && input.endsWith("られる")) return `${input.slice(0, -3)}る`;
  const base = JA_POTENTIAL_STEM[input[input.length - 2]];
  return base ? `${input.slice(0, -2)}${base}` : null;
}

/** JA lemma candidates: the surface first, then する- and potential-form fallbacks. */
function jaCandidates(input: string): string[] {
  const cands = jaSuruCandidates(input);
  const potential = jaPotentialCandidate(input);
  if (potential && !cands.includes(potential)) cands.push(potential);
  return cands;
}

/**
 * Lemma candidates for a query, keyed on SOURCE language — the per-language input seam.
 * SURFACE first, then ordered base forms; the caller keeps the first that resolves, so
 * the dictionary itself verifies the lemma (no separate lemma index).
 *   EN — morphy: irregular map + detachment rules (cats→cat, ran→run, running→run).
 *   JA — pre-lemmatized by kuromoji, but IPADIC lemmas JMdict lacks still need the
 *        する / potential fallbacks above.
 *   other — identity.
 */
export function lemmaCandidates(input: string, sourceLang: string): string[] {
  if (sourceLang.toUpperCase() === "JA") return jaCandidates(input);
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
 * First-hit-wins resolution over lemma candidates, for the single-provider directions
 * (JA→EN and every non-EN→JA pair). The caller queries the UNION of every input's
 * candidates in one RPC (`byCand` keyed by candidate); each input takes its FIRST
 * candidate that resolved, so the surface beats its fallback lemma. Re-keyed to the
 * ORIGINAL input (what the reader looks up by); unresolved inputs are omitted.
 * EN→JA uses resolvePerInputWithCandidates instead — it merges two providers.
 */
export function resolvePerInputFirstHit(
  inputs: string[],
  candsByInput: Map<string, string[]>,
  byCand: Map<string, ProviderResult[]>,
): Map<string, ProviderResult[]> {
  const out = new Map<string, ProviderResult[]>();
  for (const input of inputs) {
    for (const cand of candsByInput.get(input) ?? [input]) {
      const hit = byCand.get(cand);
      if (hit && hit.length > 0) {
        out.set(input, hit);
        break;
      }
    }
  }
  return out;
}

/**
 * BATCH EN→JA resolver — the paragraph counterpart of the single-word candidate loop.
 * Both providers are queried ONCE over the UNION of every token's candidates, so this
 * picks each token's senses with no extra round-trip: the winning lemma is the first
 * candidate WordNet resolves (post off-script filter) else the surface, the gloss
 * fallback uses THAT lemma, and results are re-keyed to the original token. Mirrors
 * single-word resolveDictionary exactly.
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
 * Assign verified rows back to the terms that asked for them, matching like the
 * single-word cache read: term == stored headword OR its reading, so a kana search
 * (ねこ) still collects the kanji row (猫). Primary sense first; no match → [].
 */
/** Han range — "did the user type kanji". */
const HAS_KANJI = /[\u4E00-\u9FFF]/u;

/**
 * Put the rows whose HEADWORD is exactly what was searched first. Stable: it only
 * partitions, so whatever ordering the caller established survives inside each group.
 *
 * The cache read matches `input` OR `input_reading`, which is what lets a kana search
 * find the kanji rows — but it runs in reverse too. A `uk` entry headwords as its KANA
 * and carries the KANJI in input_reading, so searching 質 also matched the たち rows,
 * and those outranked the real 質 rows on frequency (577 vs 465). The result: 質 answered
 * "nature; disposition" and "quality" never appeared. This is the cache-side half of
 * migration 20260758, which made jmdict_lookup prefer the written form; without it the
 * fix is invisible, because a cached word never reaches the lookup.
 *
 * Kanji-guarded for the same reason as the SQL: on kana input a kana-headword entry
 * would leapfrog the kanji entry a searcher usually wants (ねこ must still answer 猫).
 */
export function preferWrittenForm<T extends { input: string }>(rows: T[], term: string): T[] {
  if (rows.length < 2 || !HAS_KANJI.test(term)) return rows;
  const exact: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (r.input === term ? exact : rest).push(r);
  return exact.length === 0 || rest.length === 0 ? rows : [...exact, ...rest];
}

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
    // The searched form wins over a uk entry that merely lists it (see above).
    out.set(input, preferWrittenForm(matched, input));
  }
  return out;
}

// ── Single-word sense overrides (server-side twin of the client's
// src/services/language/readingOverrides.ts — KEEP IN SYNC, cross-runtime dup).
//
// A no-context lookup ranks senses by (frequency DESC, entry, sense), and when
// homographs share a surface's frequency the tiebreak picks the WRONG primary
// (前→さき, 人→"-ian", ところ→野老). Learn/calibration build cards in the edge, so
// they need the same reorder. Reorder only — never invents a sense.

// English function words to SKIP in the EN→JA reverse-gloss search: each has no
// standalone JA vocabulary equivalent, and each appears in a huge fraction of glosses
// ("to" heads every verb gloss), making the trigram-then-regex scan pathological
// (measured: "the" → 8.8 s over the full dict). WordNet still runs and correctly
// returns nothing. Excludes function-ish words that DO have JA vocabulary (this→これ,
// up→上). Extend by hand; lowercase.
export const EN_JA_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "nor", "of", "to", "in", "on", "at",
  "by", "for", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "am",
]);

/**
 * English words that are GRAMMAR, not vocabulary: TERMINAL — they resolve to no senses
 * and stop, never reaching paid MT. Skipping the gloss scan alone wasn't enough (prod
 * cached `an`→1, `is`→ある, `my`→マイ from stray WordNet/gloss matches). Mirrors how the
 * reader greys out Japanese particles by POS.
 *
 * DELIBERATELY CONSERVATIVE — words that are also content words ("have", "can", "work")
 * stay OUT; blocking them would be a worse bug than the one this fixes.
 */
export const EN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  ...EN_JA_STOPWORDS,
  // possessive determiners — JMdict has no entry; 私の is a phrase, not a headword
  "my", "your", "his", "her", "its", "our", "their",
  "i", "me", "you", "he", "she", "it", "we", "us", "they", "them", "him",
  "this", "that", "these", "those",
]);

/** True when `input` is a single English word that is grammar rather than vocabulary. */
export function isEnglishFunctionWord(input: string): boolean {
  const w = input.trim().toLowerCase();
  return w.length > 0 && !/\s/.test(w) && EN_FUNCTION_WORDS.has(w);
}

/** True when `input` is more than one whitespace-separated token. */
export function isMultiWord(input: string): boolean {
  return input.trim().split(/\s+/).length > 1;
}

// JMdict CONJUGATION CLASSES — the tags marking an entry as an actual verb, used to bias
// an inflected English verb ("worked") toward 働く over the noun 仕事.
//
// ‼️ Bare `vs` is EXCLUDED and that is the whole fix: `vs` = "noun which takes する", so
// 仕事 is ["n","vs"] and matching it made every such noun count as a verb. `vi`/`vt` are
// out for the same reason — transitivity is a property, not a class (働く is ["v5k","vi"]).
const VERB_POS = /^(v1|v2|v4|v5|vk|vn|vr|vz|vs-)/;

/**
 * Does the SURFACE form say "this is a verb"? An EN row's part_of_speech holds the POS
 * of the matched JAPANESE sense and there is no English POS source, so the `-ed`/`-ing`
 * inflection is the one English POS signal we have.
 */
export function inflectedAsVerb(surface: string, lemma: string): boolean {
  const s = surface.trim().toLowerCase();
  if (s === lemma.trim().toLowerCase()) return false; // uninflected — says nothing
  return /(?:ed|ing)$/.test(s);
}

/**
 * Same question against a candidate list. The lemma is NOT at a fixed position in
 * `lemmaCandidates` (reading the last entry picks up junk like "worke"), so take the
 * first candidate that differs from the surface. No differing candidate = not inflected.
 */
export function inflectedVerbSurface(surface: string, candidates: string[]): boolean {
  const s = surface.trim().toLowerCase();
  const lemma = candidates.find((c) => c.trim().toLowerCase() !== s);
  return lemma ? inflectedAsVerb(surface, lemma) : false;
}

/**
 * Stable-sort verb senses ahead of the rest, only for an inflected surface: "worked"
 * led with the noun 仕事 because "work" sits at gloss 0 of both and frequency broke the
 * tie. A bias, not a filter — noun senses stay, just below.
 */
export function preferVerbSenses<T extends { partOfSpeech?: string[] | null }>(rows: T[]): T[] {
  const isVerb = (r: T) => (r.partOfSpeech ?? []).some((p) => VERB_POS.test(p));
  // Stable partition preserves the existing (headline_rank) order within each group.
  return [...rows.filter(isVerb), ...rows.filter((r) => !isVerb(r))];
}

/** surface (NFC kanji) → its correct everyday standalone reading (hiragana). */
export const SINGLE_WORD_READING_OVERRIDES: Readonly<Record<string, string>> = {
  前: "まえ", 人: "ひと", 本: "ほん", 彼: "かれ", 娘: "むすめ",
  形: "かたち", 頭: "あたま", 秋: "あき", 裏: "うら", 字: "じ",
};

/** surface (NFC kana) → its correct default WRITING (kanji headword). */
export const SINGLE_WORD_WRITING_OVERRIDES: Readonly<Record<string, string>> = {
  もの: "物", ところ: "所",
};

/** Move senses whose reading == the surface's preferred reading to the front. */
export function applyReadingOverride<T extends { inputReading: string | null }>(
  surface: string,
  senses: T[],
): T[] {
  const pref = SINGLE_WORD_READING_OVERRIDES[surface];
  if (!pref || senses.length < 2) return senses;
  const match = senses.filter((s) => s.inputReading === pref);
  if (match.length === 0 || match.length === senses.length) return senses;
  return [...match, ...senses.filter((s) => s.inputReading !== pref)];
}

/** Move senses whose headword == the surface's preferred writing to the front. */
export function applyWritingOverride<T extends { input: string }>(
  surface: string,
  senses: T[],
): T[] {
  const pref = SINGLE_WORD_WRITING_OVERRIDES[surface];
  if (!pref || senses.length < 2) return senses;
  const match = senses.filter((s) => s.input === pref);
  if (match.length === 0 || match.length === senses.length) return senses;
  return [...match, ...senses.filter((s) => s.input !== pref)];
}

/**
 * Reorder a single-word (no context) result so the correct primary leads — writing
 * override, then reading override. Used by the edge's card / single-word assembly so
 * learn, calibration and translate agree on the primary.
 */
export function orderSensesForInput<
  T extends { input: string; inputReading: string | null; partOfSpeech?: string[] | null },
>(input: string, words: T[]): T[] {
  const ordered = applyWritingOverride(input, applyReadingOverride(input, words));
  // At READ time, not only in the projection, so it also fixes rows ALREADY cached (a
  // projection-only fix would need a version bump to reach them). Safe for every
  // language: the test needs an -ed/-ing surface with a differing lemma.
  return inflectedVerbSurface(input, lemmaCandidates(input, "EN"))
    ? preferVerbSenses(ordered)
    : ordered;
}

// ── PostgREST list-filter chunking ─────────────────────────────────────────
// Hand-mirrored from src/lib/urlFilter.ts (separate Deno runtime); keep in sync —
// tests/edge/url-filter.test.ts fails on drift.
//
// PostgREST puts filter values in the query string, and past some URL length the
// request can't be sent at all (from Deno: "TypeError: error sending request", which
// on prod silently greyed out every word of a 161-term paste). Percent-encoded
// Japanese is ~9 bytes per CHARACTER, hence a byte budget rather than an item count.

export const URL_FILTER_BUDGET_BYTES = 3000;
const PER_VALUE_OVERHEAD = 4;

/**
 * Split `values` so each chunk's encoded size stays within budget. `repeats` = how many
 * times the list appears in ONE url (the cache read matches input AND input_reading → 2).
 */
export function chunkForUrlFilter(
  values: string[],
  opts: { budgetBytes?: number; repeats?: number } = {},
): string[][] {
  const budget = Math.max(1, (opts.budgetBytes ?? URL_FILTER_BUDGET_BYTES) / (opts.repeats ?? 1));
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + PER_VALUE_OVERHEAD;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(value);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
