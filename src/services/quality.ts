// =========================================================
// User-filed quality reports — "this word is wrong".
//
// The admin equivalent lives in services/admin.ts and is gated on is_admin(). This is
// the LEARNER's door to the same table: a flag on a word in the reader, or under a
// flashcard. Distinct file because nothing here is admin-only, and importing the admin
// service from an ordinary reading surface would invite the two to blur.
//
// The surface fills `input` (and `wordId` when it knows the exact sense, or `output` for
// a translation) from what the user was looking at, so a report always carries a
// precise target. The NOTE is the user's and is required: a bare flag is too easy to
// send by accident and gives triage nothing to act on. (The RPC itself still accepts a
// blank one — migration 20260757 — so builds already installed keep working.)
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError, ServiceError } from "./errors";
import { nfcTrim } from "../lib/text";

/** How much free text a reporter may attach. Long enough for a real explanation,
 *  short enough that the column can't be used as storage. Enforced here for instant
 *  feedback; the value is not security-critical (the report is the user's own text). */
export const REPORT_MAX_CHARS = 500;

/** Cap on the reported input / output themselves — a pasted paragraph, not a word, when
 *  the flag is the one on Translate's output box. Mirrors c_max_text in 20260789. */
export const REPORT_TEXT_MAX_CHARS = 5000;

/** SQLSTATE the RPC raises when a user passes its 30-per-24h cap (migration 20260757). */
const REPORT_LIMIT_SQLSTATE = "54000";

export interface QualityReportInput {
  /** What was being looked at — the headword, filled in by the calling surface. */
  input: string;
  /** The user's note — what is wrong. Required; blank/whitespace is refused. */
  description: string;
  /** The exact dictionary sense, when the surface knows it. Sharpens triage: 辛い has
   *  two senses and usually only one of them is wrong. */
  wordId?: string | null;
  /** What the app answered, when the report is about a TRANSLATION rather than a word
   *  (the flag on Translate's output box). Stored as shown: a sentence's machine
   *  translation is never cached, so it could not be looked up again later. */
  output?: string | null;
}

/**
 * File a quality report against a word.
 *
 * OUTPUT: void — the caller only needs to know it landed.
 * CONSTRAINTS: requires a session (every visitor has one, guests included). The RPC
 * caps a user at 30 reports per rolling 24h and raises when exceeded; that surfaces
 * here as a ServiceError the dialog can show verbatim.
 */
export async function reportQualityIssue(params: QualityReportInput): Promise<void> {
  const input = nfcTrim(params.input).slice(0, REPORT_TEXT_MAX_CHARS);
  if (!input) {
    throw new ServiceError("Nothing to report — no word was given.", "validation");
  }
  const description = nfcTrim(params.description ?? "").slice(0, REPORT_MAX_CHARS);
  if (!description) {
    throw new ServiceError("Say what's wrong before sending the report.", "validation");
  }
  const output = nfcTrim(params.output ?? "").slice(0, REPORT_TEXT_MAX_CHARS);
  const { error } = await supabase.rpc("report_quality_issue", {
    p_input: input,
    p_description: description,
    p_word_id: params.wordId ?? undefined,
    // Left out entirely for a word report, so those calls are unchanged.
    ...(output ? { p_output: output } : {}),
  });
  if (error) {
    // The daily cap is the one failure here a user can act on, so it gets copy of its
    // own — thrown WITHOUT a code, which is how a service says "this message is meant
    // for the reader" (see lib/errorMessage). Everything else keeps its SQLSTATE and is
    // rendered as generic copy, because a raw Postgres message helps nobody.
    if (error.code === REPORT_LIMIT_SQLSTATE) {
      throw new ServiceError(
        "You've filed a lot of reports today — thanks. Try again tomorrow.",
        "validation",
      );
    }
    throw toServiceError(error);
  }
}
