# DINO — Error Codes Reference

How failures are represented across the stack, and what each code means. There are
**three layers**, and raw database codes never leak past the first:

1. **Domain errors** (`ServiceError`, client service layer) — what hooks/UI switch on.
2. **Postgres SQLSTATEs** (raw DB) — mapped to a domain `kind` at the boundary
   (`src/services/errors.ts`); some are handled specially in SQL/edge code.
3. **Edge function HTTP statuses** — returned by the `translate` Edge Function.

---

## 1. Domain error kinds (`ServiceErrorKind`)

Every service failure is wrapped in a `ServiceError` carrying a coarse, stable
`kind` (the UI branches on this) plus the original provider `message` + `code` for
logging. Source: `src/services/errors.ts` (`toServiceError`, `unwrap`).

| `kind` | Meaning | Typical trigger | Suggested UI |
|---|---|---|---|
| `conflict` | The thing already exists | unique violation (23505) | "Already in your lists" — treat as success/no-op |
| `not_found` | A required row was absent | PGRST116 (no row for `.single()`); missing FK target | "Not found" / refresh |
| `permission` | Not yours / not allowed | RLS denial (42501) | "You don't have access" (shouldn't normally surface) |
| `validation` | A constraint or input check failed | check/FK/not-null (23514/23503/23502); app-side guards | Inline field error — surface the message |
| `unknown` | Anything unmapped | network, unexpected provider error | Generic "Something went wrong; try again" |

App-side input checks throw `validation` directly (e.g. empty word, source == target),
without a SQLSTATE.

---

## 2. Postgres SQLSTATE → domain kind

The mapping in `errors.ts` (`KIND_BY_CODE`). Anything not listed → `unknown`.

| SQLSTATE | Postgres name | → kind | Where it shows up |
|---|---|---|---|
| `23505` | unique_violation | `conflict` | re-saving a sense; duplicate list name; `uq_user_words_*` |
| `23503` | foreign_key_violation | `validation` | dangling `dictionary_word_id` / `user_word_id` |
| `23502` | not_null_violation | `validation` | missing required column |
| `23514` | check_violation | `validation` | `confidence_rating` range, `review_log.grade`, `user_words_has_meaning` |
| `42501` | insufficient_privilege | `permission` | **RLS** denial (e.g. tagging another user's list/word) |
| `PGRST116` | *(PostgREST)* no rows for `single()` | `not_found` | a required single-row read returned nothing |

### Notable SQLSTATEs handled *inside* SQL/edge code (not surfaced as a kind)

These are caught or designed-around server-side, so callers rarely see them — but
they're load-bearing and worth knowing:

| SQLSTATE | Name | Where / why |
|---|---|---|
| `21000` | cardinality_violation ("ON CONFLICT cannot affect row a second time") | The edge **dedupes senses** before upserting `words` — JMdict can return the same translation twice (私 → "I; me"), and one `INSERT … ON CONFLICT` can't update a row twice. Dropping the dedupe re-breaks common words. |
| `42P10` | invalid_column_reference ("no unique/exclusion constraint matching ON CONFLICT") | PostgREST upsert can't target a **partial** unique index. `create_custom_word` therefore INSERTs and, on a unique violation (`23505`), re-fetches the existing row instead of using `ON CONFLICT`. `saveDictionaryWord`'s index was made a full constraint so its upsert infers cleanly. |

---

## 3. Edge Function HTTP status codes (`translate`)

Returned by `supabase/functions/translate/index.ts`. The frontend client
(`services/translation/client.ts`) treats some as retriable (see §4).

| Status | Meaning | Cause |
|---|---|---|
| `200` | Success | Single: `{ translated, translation, word, words }`. Batch: `{ results: [...] }`. A *no result* is still `200` with `{ translated: false, … }`. |
| `400` | Bad request | Invalid JSON body; missing `sourceLang`/`targetLang`/`input`; `source == target`. |
| `405` | Method not allowed | Anything but `POST` (and the `OPTIONS` CORS preflight). |
| `413` | Payload too large | Paragraph exceeds the caller's `paragraphCharLimit` (MT-fallback path only). Body carries `{ limit, length }`. |
| `429` | Too many requests | Reserving this request's chars would exceed the user's `monthlyCharQuota`. Body carries `{ used, quota }`. Reservation is atomic (`consume_translation_quota`) — a denied request costs nothing. |
| `500` | Server error | A `words` upsert failed, or `resolveBatch` threw. |

Notes:
- `413`/`429` are enforced **before** the paid Google MT call, and only on a JMdict
  miss — so the free tier holds even if the client is bypassed.
- A missing `TRANSLATION_API_KEY` is **not** an error: MT degrades to "no result"
  (`translated: false`), so JMdict-only operation is unaffected.

---

## 4. Transient vs deliberate (client retry policy)

`services/translation/client.ts` retries **transient** edge failures up to 3 times
with backoff (`150ms × attempt`); **deliberate** failures surface immediately.

| Classification | Examples | Retried? |
|---|---|---|
| Transient | `FunctionsFetchError` (dropped connection / killed isolate), `FunctionsRelayError`, any **5xx** | ✅ retried |
| Deliberate | **4xx** (e.g. `400`, `413`, `429`) | ❌ surfaced now |

---

## Quick reference: where each layer is produced

- Domain kinds + SQLSTATE map: `src/services/errors.ts`
- Raw SQLSTATEs asserted by tests: `tests/integration/constraints.integration.test.ts`, `rls.integration.test.ts`
- Edge HTTP statuses: `supabase/functions/translate/index.ts`
- Retry classification: `src/services/translation/client.ts` (`isTransient`)
