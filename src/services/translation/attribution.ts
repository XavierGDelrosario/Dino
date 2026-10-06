// When does a shown translation owe Google's mark? (cloud.google.com/translate/attribution)
//
// A SENTENCE's translation always does — it is Google's whether it came from the cloud
// or the phone (ML Kit). A WORD's does only when the dictionary had no entry and the
// meaning came from machine translation: those cache rows carry no dictionary entry id.
// A dictionary meaning is not Google's, and an echo (nothing to translate, the output IS
// the input) is not a translation at all.

export function isMachineOutput(p: {
  mode: "word" | "paragraph";
  input: string;
  output: string;
  /** The word-mode meanings, primary first. */
  meanings: readonly { jmdictEntryId: string | null }[];
}): boolean {
  if (!p.output.trim()) return false;
  if (p.mode === "paragraph") return p.output.trim() !== p.input.trim();
  return p.meanings.length > 0 && p.meanings[0].jmdictEntryId == null;
}
