// The i18n label keys for a word's attribute bands — shared by the word-info "?"
// panel (which NAMES a band) and the Lists filter menu (which FILTERS on it), so
// the two can never drift into calling the same band different things.
//
// Statically typed against MessageKey, so a renamed/missing catalog key is a
// COMPILE error, not a runtime blank.
import type { MessageKey } from "../../i18n";
import type { PosCategory } from "../../services/language";

/** Commonness band 1..5 (1 = most common, from corpus frequency) → its label key. */
export const COMMONNESS_LABEL_KEY: Record<number, MessageKey> = {
  1: "commonness.veryCommon",
  2: "commonness.common",
  3: "commonness.fairlyCommon",
  4: "commonness.uncommon",
  5: "commonness.rare",
};

/** Coarse POS category → its label key. Insertion order = the filter's display order. */
export const POS_LABEL_KEY: Record<PosCategory, MessageKey> = {
  noun: "pos.noun",
  pronoun: "pos.pronoun",
  verb: "pos.verb",
  adjective: "pos.adjective",
  adverb: "pos.adverb",
  particle: "pos.particle",
  conjunction: "pos.conjunction",
  interjection: "pos.interjection",
  auxiliary: "pos.auxiliary",
  counter: "pos.counter",
  prefix: "pos.prefix",
  suffix: "pos.suffix",
  numeric: "pos.numeric",
  determiner: "pos.determiner",
  expression: "pos.expression",
};
