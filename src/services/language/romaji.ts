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

    // An apostrophe only disambiguates ん (hon'ya) — it maps to nothing.
    if (ch === "'") {
      i += 1;
      continue;
    }
    // A hyphen is the ー長音 mark, which is how a loanword is typed (ra-men → らーめん).
    // Readings store ー, so without this no katakana word is reachable from romaji.
    if (ch === "-") {
      out += "ー";
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

// ── Kana → romaji (the other direction) ─────────────────────────────────────
// For NAMES only: a person's name has no meaning to show, just how it is read, and a
// learner who can't yet read kana quickly wants that in Latin letters. Hepburn, with
// long vowels collapsed the way names are usually written (さとう → Sato, おおたに →
// Otani), and the first letter capitalised. It is exactly as right as the reading it
// is given — and a name's reading is the tokenizer's guess.

const KANA_ROMAJI: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ゔ: "vu",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
};
/** Small ゃ/ゅ/ょ after an い-row kana: き+ゃ → kya, し+ゃ → sha, ち+ゃ → cha, じ+ゃ → ja. */
const YOON: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };

/**
 * A kana reading as a romanized NAME ("たなか" → "Tanaka"), or null when it holds
 * anything that isn't kana (so a caller never shows half-converted text).
 */
export function nameRomaji(reading: string | null | undefined): string | null {
  if (!reading) return null;
  // Katakana → hiragana, so one table serves both.
  const kana = reading.normalize("NFC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  let out = "";
  let double = false; // a pending っ: doubles the next consonant
  for (let i = 0; i < kana.length; i++) {
    const c = kana[i];
    if (c === "っ") {
      double = true;
      continue;
    }
    if (c === "ー") continue; // the long mark: dropped, like the collapsed vowels below
    let syllable = KANA_ROMAJI[c];
    if (syllable === undefined) return null;
    const y = YOON[kana[i + 1]];
    if (y && syllable.endsWith("i") && syllable.length > 1) {
      // shi+ya → sha, chi+yu → chu, ji+yo → jo; ki+ya → kya, ri+yo → ryo.
      const stem = syllable.slice(0, -1);
      syllable = /^(sh|ch|j)$/.test(stem) ? stem + y : `${stem}y${y}`;
      i++;
    }
    if (double) {
      syllable = (syllable.startsWith("ch") ? "t" : syllable[0]) + syllable;
      double = false;
    }
    // ん before a vowel or y would read as な/にゃ: mark the break.
    if (out.endsWith("n") && kana[i - (y ? 2 : 1)] === "ん" && /^[aiueoy]/.test(syllable)) out += "'";
    out += syllable;
  }
  if (!out) return null;
  // Long vowels as names are written: ou/oo → o, uu → u.
  out = out.replace(/o[ou]/g, "o").replace(/uu/g, "u");
  return out[0].toUpperCase() + out.slice(1);
}
