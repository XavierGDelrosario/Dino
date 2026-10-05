// Ids that are NOT a `words` row. Its own tiny module (rather than living in
// repository.ts) so both the lookup and the vocabulary services can import it without
// pulling the dictionary reader in — and so a test that mocks the repository still has it.

/**
 * Id prefix of a sense that is NOT a `words` row — today, a name's stand-in in the
 * reader (lookup.ts `nameSense`). Such an id must never be sent to the database: one
 * non-uuid in a filter makes Postgres reject the whole read (22P02).
 */
export const SYNTHETIC_WORD_ID_PREFIX = "name:";

/** True for an id with no `words` row behind it (see SYNTHETIC_WORD_ID_PREFIX). */
export function isSyntheticWordId(wordId: string): boolean {
  return wordId.startsWith(SYNTHETIC_WORD_ID_PREFIX);
}
