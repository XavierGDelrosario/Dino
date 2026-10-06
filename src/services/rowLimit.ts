// "A per-user row cap was hit" — the signal behind the account prompt. Migration
// 20260785 caps each user's rows (guests lower: 1,000 words since 20260793), and the
// database refuses the insert with a check-violation whose message names the table and
// the ceiling. Every save path goes through toServiceError (services/errors), which
// recognises that message and publishes it here, so ONE notice in the app shell
// (components/common/RowLimitNotice) covers Translate, the quizzes, Learn, Articles and
// Lists without each hook knowing about caps. A LEAF module with no imports — errors.ts
// depends on it, nothing may depend back.

export interface RowLimitHit {
  /** The capped table: "user_words" (saved words), "lists", "media_favorites". */
  table: string;
  /** The ceiling the user is at. */
  max: number;
}

/** The exact text user_rows_cap() raises: `<table> limit reached (<n> rows)`. */
const LIMIT_MESSAGE = /^(\w+) limit reached \((\d+) rows\)/;

/** Parse a database error message into a hit, or null when it is something else. */
export function parseRowLimit(message: string | undefined): RowLimitHit | null {
  const m = message ? LIMIT_MESSAGE.exec(message) : null;
  return m ? { table: m[1], max: Number(m[2]) } : null;
}

const listeners = new Set<(hit: RowLimitHit) => void>();

export function onRowLimit(fn: (hit: RowLimitHit) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function notifyRowLimit(hit: RowLimitHit): void {
  for (const fn of [...listeners]) fn(hit);
}
