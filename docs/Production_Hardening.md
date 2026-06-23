# Production Hardening & Long-Term Concerns

Pre-publish security/ops checklist. Each item = **current state** (verified where
noted) + the **action** before a real launch. Complements the feature roadmap in
`CLAUDE.md` (this is the security/ops view; that's the product view).

---

## 1. Database privileges — least privilege, esp. DELETE

### 1a. Dictionary & derived data — keep it write-/delete-locked
Tables: `words` (cache), `jmdict_*` (source), `word_embeddings` (#11),
`translation_usage`.

- **Current (verified):** clients (`anon`/`authenticated`) have **no DELETE** on
  any of these. `jmdict_*` and `word_embeddings` are server-only (RLS on, no
  policies/grants) — even **`service_role` is denied** `word_embeddings` (the
  integration test confirmed `42501`). `words` is written by the edge function
  (service role); deletes are superuser-only.
- **Action:** make it explicit — `REVOKE DELETE ON words, jmdict_*, word_embeddings
  FROM anon, authenticated, service_role`. The only mutators are the **ingest
  scripts** (run as the DB owner via `DATABASE_URL`) and forward-only migrations.
  "Deleting" dictionary data = re-run the ingest (truncate+reload), never ad-hoc
  `DELETE`. Protects against a leaked anon/service key wiping the dictionary.

### 1b. User data — delete ONLY via narrow, intentional paths (the key ask)
Tables: `user_words`, `lists`, `list_words`, `review_log`, `users`, `user_limits`.

- **Current (verified):** a user can `DELETE` their **own** `user_words` / `lists`
  / `list_words` (RLS-scoped — correct self-service). `review_log` is append-only
  (no client INSERT/DELETE). `users` / `user_limits` are not client-deletable.
- **The gap:** `service_role` **bypasses RLS**, so today an admin/service path (or
  a leaked service key) could mass-delete user data.
- **Action — "even admin can't user-delete":** `REVOKE DELETE ON user_words, lists,
  list_words, users, review_log FROM service_role`. After that the ONLY deletion
  paths are: **(a)** the user's own RLS-scoped self-service delete, and **(b)** a
  single, audited **account-deletion** `SECURITY DEFINER` function that erases only
  the target user and writes an audit row.
- **Caveat:** you still need *one* deliberate deletion path — GDPR "right to
  erasure" + abandoned-guest cleanup. "No admin delete" means **no broad/accidental
  delete**, not zero delete: a narrow, logged, intentional function is required.
- **`review_log` is irreplaceable** (FSRS training history) — append-only forever,
  always in backups, never grant DELETE.

### 1c. General
- Scope `service_role` to exactly what the edge function needs (write `words` +
  `translation_usage`, read `user_limits`), not blanket `GRANT ALL`.
- Audit: every table RLS-enabled with correct policies (the integration suite
  covers most). Add an `audit_log` for privileged mutations (account deletion,
  dictionary re-ingest).

## 2. Backups & durability
- Hosted Supabase: enable **automated daily backups + PITR** (pick a tier that
  includes point-in-time recovery).
- **Must back up (user-generated, NOT reproducible):** `users`, `user_words`,
  `lists`, `list_words`, `review_log`, `user_limits`, `translation_usage`.
- **Reproducible (lower priority):** `words`, `jmdict_*`, `word_embeddings`,
  `data/frequency` — rebuildable from pinned source releases + the in-repo scripts
  (`ingest-jmdict`, `build-frequency.py`, `build-embeddings.py`). Keep those pinned.
- **Test restores** periodically (an untested backup is a hypothesis). Keep an
  off-site export of the irreplaceable user tables on a schedule.

## 3. Rate limiting & abuse — the biggest gap
- The paid path is the `translate` edge function (Google MT). It already has a
  per-user **monthly char quota + per-request char cap** (`consume_translation_quota`,
  reserve-before-call, atomic).
- **THE LOOPHOLE:** the quota is per-user, but **anonymous sign-in mints a fresh
  user freely** → an attacker spins up unlimited anon users, each with a new quota.
  Before launch:
  - Rate-limit **anonymous sign-ins** (Supabase Auth limits) + captcha at scale.
  - Per-IP / per-token rate limiting at the gateway/edge (e.g. Cloudflare), separate
    from the per-user quota.
  - A **global daily MT spend ceiling / kill-switch** so a breakout can't run an
    unbounded bill.
- Set a hard **billing cap + alerts** on Google Cloud + Supabase (defense behind
  the app-level quota).

## 4. DDoS / network / WAF
- Front the app + edge with a **CDN/WAF** (Cloudflare or similar): DDoS absorption,
  WAF rules, bot mitigation, per-IP limits.
- **CORS:** set `ALLOWED_ORIGINS` to the real origin(s) in prod (it's `*` only as a
  dev default; the env support already exists).
- Ensure **verify-jwt is ON** for the edge function in prod (we used
  `--no-verify-jwt` only for local smoke tests).

## 5. Secrets & keys
- `service_role` key + `TRANSLATION_API_KEY` are server-only — never in the client
  bundle, never committed. The `anon` key is public by design (RLS is the boundary).
- Rotate on a schedule + immediately on any suspected leak. Restrict the Google API
  key (API + referrer/IP restrictions, quota caps). Add secret-scanning to CI.

## 6. Auth & account lifecycle (roadmap #13)
- Replace anonymous guest with real auth + a **guest→account upgrade** preserving
  `user_words`/`lists`/`level` (link the anon uid on sign-up).
- **Abandoned-guest cleanup** policy (delete inactive guests after N days) — via the
  narrow account-deletion function, logged.
- Email verification / OAuth, password policy, session expiry.

## 7. Input & injection safety
- Reads/writes go through PostgREST + parameterized RPCs → SQLi-resistant. The one
  hand-built filter (edge `fetchVerified`/`fetchVerifiedMany` `.or(...)`) quotes
  interpolated values (already hardened) — keep that discipline for any future
  dynamic SQL. NFC-normalize + validate at boundaries (done).

## 8. Cost controls
- MT: per-user quota + global ceiling + billing cap (§3). Embeddings/frequency are
  one-time compute (no per-request cost). Track Supabase DB size + egress (full
  JMdict + 22.6k embeddings fit the free tier with headroom, but watch growth).

## 9. Observability
- Error logging + alerting: edge failures, quota denials, auth anomalies, RLS
  denials. Metrics: MT spend/day, anon sign-up rate, translate latency, DB size.
  A health check endpoint.

## 10. Legal / compliance
- **EDRDG (JMdict) attribution in the UI** — required before public (roadmap #15).
- wordfreq data CC-BY-SA (attribution in `ATTRIBUTION.md`; we ship only derived
  numbers — done). Embedding model `multilingual-e5-small` is MIT — fine.
- Privacy policy + GDPR: data export + the account-deletion/erasure path (§1b).

## 11. Operational concerns (additional)
- **Schema/migration drift — the biggest operational risk.** Development has been
  hand-applying SQL to the live DB and editing the already-applied `init.sql`, so
  the **running DB and the migration files can silently diverge** — a clean deploy
  "from migrations" may not reproduce what's been tested. Action: reconcile
  `init.sql` ↔ live, prove a fresh `supabase db reset` yields the exact working
  schema, then move to **forward-only numbered migrations** (never edit an applied
  one). Until then, treat the live local DB as authoritative and re-derive.
- **Unbounded queries.** `getAllUserWords` / `getUserWordStates` / the Lists view
  fetch *everything* for a user (no `LIMIT`) — O(vocabulary). Fine at POC scale, a
  latency/memory cliff later. Paginate (the review queue already moved to SQL+LIMIT).
- **Third-party data egress (privacy).** Every pasted paragraph is sent to **Google
  Translate**. Disclose it in the privacy policy; consider a JMdict-only / no-MT
  mode for sensitive content. Decide what is acceptable to send off-system.
- **Retry idempotency.** The translate client retries on 5xx/transient. A request
  that succeeded but whose response was lost gets retried → the quota `reserve` runs
  twice (over-*counts* usage, never over-spends — safe direction, but a known gap).
- **Deploy & rollback.** No migration-down path, no blue-green, no feature flags,
  no tested rollback. Add before a real launch.
- **Load/perf testing.** Never done: HNSW index params (`m`/`ef_*`) at default,
  connection limits, concurrent translate, the embeddings query under load.

## 12. AI-codebase review checklist
This codebase is largely AI-built; these are the characteristic failure modes to
audit for, each one we *actually hit* this project (so they're real, not generic):

- [ ] **Tests prove intent, not behaviour.** Mocked unit tests assert "right args
  sent" and pass while the system is broken — the `save_dictionary_words` RLS bug
  shipped past all unit tests; only a *live integration* test caught it (`42501`).
  → Integration/e2e against real infra for anything touching RLS, transactions,
  constraints. Don't trust green mocks.
- [ ] **Plausible-but-wrong on subtle semantics** (RLS visibility, transaction
  snapshots, concurrency, ordering). The CTE-snapshot bug *read* correct. → Review
  every authz boundary + anything concurrent assuming the subtle part is wrong.
- [ ] **Happy-path bias / missing edge cases** (NFC vs apostrophe variants, sparse
  calibration data, negative-result caching, empty/huge inputs). → Per feature,
  enumerate empty / null / huge / unicode / concurrent / failure explicitly.
- [ ] **Swallowed errors** (`.catch(() => {})` in `getUserLevel`, calibration
  persist, kuromoji warm-up). → Audit each; log even the "non-fatal" ones so they
  aren't invisible.
- [ ] **"Looks done" ≠ works.** #9 (extract-and-quiz) was marked done but had never
  been *run* until browser-verified. → Nothing is done without a real end-to-end run.
- [ ] **Confidently wrong / drifting comments.** The rich comments are an asset but
  AI writes them authoritatively and they drift. → Trust code over prose; spot-check
  load-bearing comments against behaviour.
- [ ] **Version/dependency hallucination** (torch+numpy ABI, Python 3.9 `int|None`,
  `.at()` lib target — all this session). → Pin versions; run against the actual
  toolchain early; don't trust "this should work."

Throughline: **AI is strong on the happy path, weak on adversarial/edge/integration
reality.** Lean on integration tests, adversarial review, and real end-to-end runs.

---

**Priority order for a first publish:** §11 (reconcile migration drift) → §1b (lock
user-data DELETE) → §3 (anon rate-limit + MT kill-switch) → §2 (backups+PITR) → §4
(WAF/CORS/verify-jwt) → §10 (attribution) → §6 (real auth). Several overlap with
roadmap #13/#14/#15.
