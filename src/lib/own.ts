// Own-property lookup for maps keyed by USER INPUT.
//
// An object literal inherits Object.prototype, so `EN_IRREGULARS["constructor"]` does
// not return undefined — it returns a FUNCTION, for a word an English learner can
// legitimately type (a constructor is a builder; WordNet lists it, above our frequency
// floor). Found by re-measuring band coverage over the whole common-lemma set: the edge
// threw `c.toLowerCase is not a function` and the reader handed back a Function as if it
// were a lemma. `valueOf`, `toString` and `isPrototypeOf` are the same shape.
//
// Any map whose key comes from the user needs this. A map keyed by something we control
// (a language code, a SQLSTATE, a kana syllable) does not.
//
// The edge function keeps its own copy — it runs in Deno and cannot import from src/.

/** `map[key]`, but only if `key` is the map's OWN property. */
export function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
