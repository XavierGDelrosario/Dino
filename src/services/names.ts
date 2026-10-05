// Curated names — the hand-kept corrections for names the tokenizer reads or splits
// wrong (migration 20260788, table `curated_names`). 大谷翔平 lattices as 大谷 (read
// オオヤ) + 翔 + 平; a row for it makes the reader show ONE name, "Shohei Ohtani".
//
// A small public reference table, read once per session per language pair. NEVER
// throws and never blocks the reader: an un-migrated database, a network failure or an
// empty table all mean "no curated names", and names fall back to the tokenizer.
import { supabase } from "../config/supabaseClient";
import type { AnalyzedToken, LangCode } from "./language";

export interface CuratedName {
  reading: string | null;
  meaning: string;
  kind: "person" | "organization";
}
export type CuratedNames = ReadonlyMap<string, CuratedName>;

const EMPTY: CuratedNames = new Map();
const loads = new Map<string, Promise<CuratedNames>>();

/** Test hook: the per-session memo is module-global. */
export function __resetCuratedNames(): void {
  loads.clear();
}

/** The curated names for a pair, keyed by surface. Memoized; a failed load is retried next time. */
export function getCuratedNames(sourceLang: LangCode, targetLang: LangCode): Promise<CuratedNames> {
  const key = `${sourceLang}>${targetLang}`;
  let load = loads.get(key);
  if (!load) {
    load = fetchNames(sourceLang, targetLang).then((names) => {
      if (names === EMPTY) loads.delete(key); // don't memoize a failure
      return names;
    });
    loads.set(key, load);
  }
  return load;
}

async function fetchNames(sourceLang: LangCode, targetLang: LangCode): Promise<CuratedNames> {
  try {
    const { data, error } = await supabase
      .from("curated_names")
      .select("surface, reading, meaning, kind")
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang);
    if (error || !data) return EMPTY;
    const out = new Map<string, CuratedName>();
    for (const r of data) {
      out.set(r.surface.normalize("NFC"), {
        reading: r.reading,
        meaning: r.meaning,
        kind: r.kind === "organization" ? "organization" : "person",
      });
    }
    return out;
  } catch {
    return EMPTY;
  }
}

/** The longest run a curated name may be split into (大谷翔平 is three tokens). */
const MAX_NAME_SPAN = 5;

/**
 * Fold every run of adjacent tokens whose surfaces join to a curated name into ONE name
 * token (longest match first, left to right), and tag a single token that IS a curated
 * name. Pure. The merged token is off content POS like any name — it is not vocabulary —
 * and carries the curated reading.
 */
export function mergeCuratedNames(tokens: AnalyzedToken[], names: CuratedNames): AnalyzedToken[] {
  if (names.size === 0 || tokens.length === 0) return tokens;
  const out: AnalyzedToken[] = [];
  let changed = false;
  for (let i = 0; i < tokens.length; ) {
    let merged: AnalyzedToken | null = null;
    let span = 0;
    for (let n = Math.min(MAX_NAME_SPAN, tokens.length - i); n >= 1; n--) {
      const run = tokens.slice(i, i + n);
      // Only tokens that sit edge to edge: a space or a line break between them means
      // they were not written as one name.
      if (run.some((t, k) => k > 0 && t.start !== run[k - 1].end)) continue;
      const surface = run.map((t) => t.text).join("").normalize("NFC");
      const hit = names.get(surface);
      if (!hit) continue;
      merged = {
        text: run.map((t) => t.text).join(""),
        start: run[0].start,
        end: run[n - 1].end,
        reading: hit.reading,
        lemma: surface,
        pos: hit.kind === "organization" ? "組織" : "人名",
        nameKind: hit.kind,
      };
      span = n;
      break;
    }
    if (merged) {
      out.push(merged);
      changed = true;
      i += span;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return changed ? out : tokens;
}
