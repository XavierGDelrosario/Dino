# First Publishable Build — Launch Checklist

The product is built; the gap to publishable is almost entirely non-feature work
(auth, deploy, security, cost, legal). Tags: `[concern]` = a concern raised directly ·
`[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`. Completed items are removed
as they land — this list is the REMAINING work.

**Done so far:** Translate (JMdict + MT) · Lists · Review (SRS) · the full
differentiator thread (#8 difficulty · #9 extract-and-quiz · #10 calibration · #11
word map · #12 domain quizzes) · perf pass · NFC hardening · delete-lockdown · RLS
audit (all 14 tables) · integration coverage on risky DB paths (incl. the edge I/O
shell, black-box) · swallowed-error logging · JMdict/wordfreq attribution notice
(#15) · vocabulary pagination · reproducible embedding build · a clean `supabase db
reset` that reproduces the schema and reseeds the dictionary (no re-ingest) · retry
idempotency for the paid MT path · in-code observability (health check, request log,
MT-spend metric) · off-site user-data backup + tested restore (`db:backup` /
`db:restore-test`) · UI i18n — full EN/JA localization layer with a language picker (#17)
· cost-control code (#1): MT kill-switch (`MT_DISABLED`) + global monthly spend cap
(`GLOBAL_MONTHLY_CHAR_QUOTA` / `consume_global_quota`) · real auth core (#13):
email/password accounts + data-preserving guest→account upgrade + password reset.

## 🔴 Tier 1 — Required for a real launch (build work)
*(Tier 0 — the security/cost CODE blockers — is cleared: delete-lockdown, RLS audit,
and the cost-control code (#1 kill-switch + global cap) are all done.)*
1. **Real auth** — `[#13]` **DONE (2026-06-24):** email/password accounts via an
   in-place **guest→account upgrade** (`updateUser` keeps the same `auth.uid()`, so
   all vocab/lists/reviews carry over), sign-in/sign-out, and **password reset**
   (request email → recovery link → set new password — full flow verified live via
   Mailpit). `AccountMenu` + `ResetPasswordView`; RLS unchanged (keyed on
   `auth.uid()`). *Remaining (minor):* prod email-confirmation handling (local has
   confirmations OFF → applies immediately; prod should enable them + a "check your
   email" state); optional OAuth (additive — config + a button); the existing
   "complete account deletion" follow-up (`delete_account` ≠ `auth.users` row).
2. **Deploy** — `[#14]` **This is the gate that unlocks Tier 2.** *Prep DONE
   (2026-06-24):* prod build verified green; prod `/dict/*.gz` serving fixed via
   `public/_headers` (Cloudflare Pages / Netlify; the prod equivalent of the dev
   `serveDictRaw` plugin); step-by-step runbook in `docs/Deploy.md`. *Targets:*
   hosted Supabase **Free + common JMdict** → clean upgrade to Pro + full later
   (re-ingest, no code change). *Remaining (needs your cloud accounts):* create the
   hosted Supabase project + `db push` + ingest, set edge secrets (incl.
   `ALLOWED_ORIGINS`), `functions deploy`, build with cloud env + upload `dist/` to
   Cloudflare Pages.
3. **Legal — privacy + ToS** — `[§10]` privacy policy (user text → Google) + ToS.
4. **Account & auth UX** — `[#13 cont.]` the auth surface beyond the working core:
   - **Email confirmation + verification** — enable confirmations in prod; a user
     must not be able to claim someone else's email (confirmation IS the proof);
     "check your email" pending state.
   - **Password strength** — enforce server-side (`config.toml` `minimum_password_
     length` + `password_requirements`) AND client-side validation (currently min 6,
     no rules).
   - **Google login** — `[auth.external.google]` OAuth provider + a "Continue with
     Google" button.
   - **Separate pages** for Create account · Sign in · main app (needs a router —
     currently a single page + dropdown panel).
   - **Profile page + top-right person-icon dropdown** — "Profile" → email, date
     created, **native language** (NEW field on `users`; decides default *output*),
     **learning language** (default "I'm learning" + input), **app language**
     (localization, #17). Sign-in entry from the dropdown.

## 🔒 Tier 2 — Hosted-only (our side DONE; finish on the live production Supabase)
Code/in-repo work is complete; the only remaining step is a one-time action on the
hosted Supabase or an external console **after #3 (Deploy)** stands it up. None of
these can be progressed locally — that's why they're deferred, not unfinished. (Once
prod is live with real data you can't just `db reset`, hence "not easily changed".)
5. **Prod security config** — `[§4/§5]` set `ALLOWED_ORIGINS`, verify-jwt ON, restrict
   the Google key (code seams ready). *Repo-side piece doable pre-launch: secret-scan CI.*
6. **Cost protection — hosted** — `[concern · §3]` anon-signup rate limit (Supabase
   auth dashboard) + hard billing caps (Google & Supabase consoles). The code side is
   done (MT kill-switch + global monthly cap); these are the external-console backstops.
7. **Forward-only migrations** — `[concern · §11]` adopt the forward-only, never-edit-
   an-applied-migration discipline. It only bites once prod holds data you can't
   `db reset`; clean-reset reproduction is already proven.
8. **Automated backups + PITR** — `[concern · §2]` flip the hosted paid-tier toggle +
   schedule `db:backup` off the DB host. Backup + tested-restore tooling is done.
9. **Observability — alerting** — `[§9]` point the edge's structured logs (health /
   request / `mt_spend`, all emitting) at hosted alerting (spend threshold, 5xx,
   uptime). In-code side done.

## 🛠 Admin tooling (operational; build as a gated admin surface)
10. **Admin webpage** — a privileged surface (role-gated; NOT a normal user) for ops:
    - **Edit the `words` dictionary cache** — drive the deferred re-projection sweep
      (see #3 / `projection_version`): flag rows older than `CURRENT_PROJECTION_VERSION`
      as outdated and re-project / merge them (the destructive sweep gated on a test
      harness, per CLAUDE.md).
    - **Usage dashboards** — total + per-user MT usage from `translation_usage` /
      `global_translation_usage`, **anonymized** (no raw email/PII — bucket by user id
      hash) to maintain privacy.
    - **DB usage by table** — `pg_total_relation_size` per table (storage headroom vs
      the tier cap).
    Server-enforced admin role (RLS / a `is_admin` claim); never a client-only gate.

## 🧪 Pre-publish QA gate — STRICT audit before the first published build
A hard gate as we approach v1: do this before going public, not after.
- **Test coverage — strict, real-DB, verifiable.**
  - Make the **integration suite (real Postgres) a first-class/CI gate**, not just
    `RUN_INTEGRATION`-opt-in; the default suite mocks and only asserts intent.
  - **Translate**: explicit single-word, paragraph, AND **roundtrip (input = target)**
    coverage; the `今 / これ / 単語` cases; readings — the **kana-vs-kanji switch**
    (`uk`) cases (e.g. なる→なる(成る) vs 鳴る(なる)) as named tests.
  - Frequency/embedding + language paths: extension seams covered per language/provider.
- **Code-QA pass.** Minimal coupling, single-purpose files, no needless repetition:
  dedup known smells (the grade arrays in FlashcardView/TextQuizView, the per-component
  `message(e)` helper); confirm each file is single-purpose; the edge↔repository mirror.
- **"Never show success on a failed write"** audit — every mutation that flips UI to a
  done/✓ state must await the DB write (audit `AddToListButton`'s optimistic ✓, etc.).
- **Leak/security sweep** — no password/email in logs or error messages; API/keys
  server-only; ownership re-checked on every user-data mutation.
- **Known-AI-flaw sweep** — hallucinated/stale comments, half-wired features, silent
  catches, off-by-one in ranking/caps, etc.

## 🛡 Content safety
- **Profanity / explicit filter on SUGGESTIONS** — explicit words may be looked up
  directly but must NOT be *suggested* as related words (the `stryker→stripper`
  symptom). Apply a blocklist to `related_words` / domain expansion output (not to
  direct lookup). Per-language list; extensible.

## 🟢 Tier 3 — Post-launch OK (features / polish)
- native app (#18). *(i18n #17 ✅ done — EN/JA; add a locale = one entry in
  `src/i18n/messages.ts`, compile-checked.)*
- **Purge dev/test guests before the first real DB** — a trivial one-time `DELETE`;
  the current anonymous rows are all throwaway (dev + me). NOT auth-gated — can run
  any time before publishing the real DB. (Ongoing abandoned-guest reaping only
  matters later, once there's public traffic + the #13 upgrade path.)
- **EN→JA reader sense quality** — the `LIMIT 12` cap stops the noise, but the
  reverse-gloss tail is still loosely matched; needs real EN→JA sense ranking.
- **Embeddings (#11) follow-ups:**
  - entry-level vectors blend homographs + produce gloss-string artifacts — consider
    per-sense or writing-weighted embedding.
  - **e5-large upgrade** — katakana loanwords cluster by SPELLING not meaning
    (ストライカー→streaker/stripper). Fix = a stronger model (e5-large 1024-dim /
    LaBSE); needs the `vector(384)` column migrated + a full re-embed (~2GB model).
  - **re-embed under the frequency-floor policy** — live vectors are the old
    `--common-only` 22.6k; the default policy (`EMBED_FREQ_FLOOR`, common ∪ freq≥250
    ≈ 41k) applies only after a re-embed + `npm run db:dump-seed`.
  - **English as a learning target** — the word map is JA-only. The embeddings KEY is
    already multi-language (`(source_lang, dictionary_ref)`, no JMdict FK) and
    `build-embeddings.py` has a per-source seam (`SOURCE_FETCHERS`, `--source-lang`);
    a non-JA language still needs its own dictionary source + `<source>_lookup()` +
    per-source `related_words` projection.
  - prod-DB regen at deploy + HNSW param tuning under load; per-language KO/ZH.

## ➕ Open follow-ups (slot into tiers as you go)
- **Complete account deletion** — `[Tier 1 / #13]` `delete_account()` erases this
  app's PUBLIC-schema data but NOT the Supabase `auth.users` row; pair it with the
  auth admin API when real auth lands, else deleted users can still sign in.
- **Real furigana (#16)** — *very low priority.* Ruby above the kanji + peel-matching-
  kana alignment (`alignFurigana`); group ruby is correct meanwhile.
- **FSRS (#19)** — *very low priority.* Upgrade the SRS to the D/S/R model (power-law
  curve, fit constants to `review_log`); a new `record_review()` body, same API. The
  HLR curve is fine for now.

---
**Throughline:** the security/cost CODE blockers are cleared. **Tier 1 is the remaining
BUILD work — auth core ✅ + the account/auth UX (pages, profile, Google, email
confirm, password rules), deploy (the gate), privacy/ToS.** **Tier 2** is config/
console actions once Deploy stands up the hosted Supabase. The **Pre-publish QA gate**
(strict real-DB test coverage + code-QA + leak/optimistic-UI sweeps) and **Content
safety** (profanity filter on suggestions) are hard gates before the first public
build. **Admin tooling** is operational. Tier 3 is post-launch polish.
