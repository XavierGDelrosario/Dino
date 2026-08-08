// =========================================================
// Romaji → hiragana, for SEARCH only.
//
// Typing "neko" when you're studying Japanese currently finds nothing, and finds it
// expensively-shaped: `jmdict_lookup('neko','JA','EN')` misses, and the edge's
// off-script guard then (correctly) refuses to buy an MT translation of a Latin string
// submitted as Japanese. So the result is silence — the one outcome that tells the user
// nothing about why.
//
// Converting to ねこ before the lookup makes it a normal query. This is a SEARCH
// convenience, never a display or storage transform: the word saved is whatever the
// dictionary returns (猫), not the typed romaji.
//
// ‼️ ALL-OR-NOTHING BY DESIGN. `toHiragana` returns null unless the WHOLE string maps
// cleanly. A partial conversion would be worse than none — "nekoX" → "ねこX" is not a
// word, and a half-converted query fails in a way that looks like a dictionary gap
// rather than a typo. The caller falls back to the raw input when it returns null, so a
// string that only looks like romaji ("cat", "PDF") is left alone and follows the
// ordinary path.
// =========================================================

/** Digraphs first — order matters, since "kya" must not be read as "ka" + "ya". */
const DIGRAPHS: Record<string, string> = {
  kya: "きゃ", kyu: "きゅ", kyo: "きょ", gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", sya: "しゃ", syu: "しゅ", syo: "しょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", jya: "じゃ", jyu: "じゅ", jyo: "じょ",
  cha: "ちゃ", chu: "ちゅ", cho: "ちょ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
  nya: "にゃ", nyu: "にゅ", nyo: "にょ", hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
  bya: "びゃ", byu: "びゅ", byo: "びょ", pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
  mya: "みゃ", myu: "みゅ", myo: "みょ", rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  shi: "し", chi: "ち", tsu: "つ", she: "しぇ", che: "ちぇ", je: "じぇ",
  fu: "ふ", ji: "じ", zi: "じ", si: "し", ti: "ち", tu: "つ", hu: "ふ",
  dzu: "づ", di: "ぢ", du: "づ",
};

const MONOGRAPHS: Record<string, string> = {
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", su: "す", se: "せ", so: "そ",
  za: "ざ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", te: "て", to: "と",
  da: "だ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  wa: "わ", wo: "を",
  a: "あ", i: "い", u: "う", e: "え", o: "お",
};

/** A trailing/standalone "n" — the one syllable that is not consonant+vowel. */
const N_KANA = "ん";

/**
 * Convert romaji to hiragana, or null when the string doesn't convert CLEANLY.
 *
 * OUTPUT: hiragana, or null (mixed script, unmapped letters, a dangling consonant).
 * CONSTRAINTS: ASCII letters only — a string containing any kana, kanji or digit is
 * returned as null, because it is already Japanese (or isn't romaji at all) and the
 * caller should use it unchanged. Case-insensitive. Handles ん (n / n' / nn) and the
 * っ sokuon (a doubled consonant).
 */
export function toHiragana(input: string): string | null {
  const src = input.trim().toLowerCase();
  if (src === "" || !/^[a-z'-]+$/.test(src)) return null;

  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // An apostrophe/hyphen only ever disambiguates ん (hon'ya) — it maps to nothing.
    if (ch === "'" || ch === "-") {
      i += 1;
      continue;
    }

    // ん: "n" not followed by a vowel or y.
    if (ch === "n") {
      const next = src[i + 1];
      if (next === undefined || !/[aiueoy]/.test(next)) {
        out += N_KANA;
        // The SECOND n of "nn" normally starts the next syllable, exactly as an IME
        // treats it: onna → おんな, sannin → さんにん. (Consuming both instead gives
        // おんあ — caught by the spec.) Only at the very END is "nn" a redundant
        // spelling of ん: honn → ほん.
        i += next === "n" && i + 2 >= src.length ? 2 : 1;
        continue;
      }
    }

    // っ: a doubled consonant (kk, tt, pp, ss…). Never for n (that is ん above).
    const next = src[i + 1];
    if (next === ch && /[bcdfghjkmpqrstvwxyz]/.test(ch)) {
      out += "っ";
      i += 1;
      continue;
    }

    const three = src.slice(i, i + 3);
    if (DIGRAPHS[three]) { out += DIGRAPHS[three]; i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (DIGRAPHS[two]) { out += DIGRAPHS[two]; i += 2; continue; }
    if (MONOGRAPHS[two]) { out += MONOGRAPHS[two]; i += 2; continue; }
    const one = src.slice(i, i + 1);
    if (MONOGRAPHS[one]) { out += MONOGRAPHS[one]; i += 1; continue; }

    return null; // an unmappable letter → not clean romaji, leave the input alone
  }

  // A trailing っ is a dangling consonant ("kk"), not a word.
  return out === "" || out.endsWith("っ") ? null : out;
}

/**
 * The search term for `input` in `lang`: its kana form when the input is clean romaji
 * for a Japanese search, else the input unchanged.
 *
 * The single place callers should touch — it keeps the "only for JA, only when clean"
 * policy in one spot rather than at every lookup site.
 */
export function searchTermFor(input: string, lang: string): string {
  if (lang.toUpperCase() !== "JA") return input;
  return toHiragana(input) ?? input;
}
