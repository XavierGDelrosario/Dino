# DINO — TODO (Launch + Roadmap)

The product is built; the gap to publishable is almost entirely non-feature work
(auth, deploy, security, cost, legal). Tags: `[concern]` = a concern raised directly ·
`[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`. This is the REMAINING work;
**everything shipped is logged at the bottom under [Completed](#-completed) with dates.**
(Renamed from `Launch_Checklist.md` → `TODO.md` on 2026-06-25.)

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
3. **Legal — privacy + ToS** — `[§10]` ✅ **DRAFTED (2026-06-24):** in-app `/privacy`
   + `/terms` pages (footer-linked) reflecting the real data flows (Supabase storage;
   Google receives translated text; account deletion). *Remaining: counsel review*
   before publishing (they're marked DRAFT).
4. **Account & auth UX** — `[#13 cont.]` DONE (2026-06-24):
   - ✅ **Password strength** — server (`minimum_password_length=8` +
     `password_requirements="letters_digits"`) + client validation.
   - ✅ **Separate pages** — in-house router; `/signin`, `/signup`, `/profile`, `/`;
     SPA fallback (`public/_redirects`).
   - ✅ **Profile page + person-icon dropdown** — email, member-since, **native
     language** (`users.native_language`, drives default output), learning language,
     app language; native/learning persist + default the Translate directions.
   - ✅ **Email confirmation** — `upgradeToAccount` detects pending (prod confirmations
     on) → AuthPage shows "check your email"; local (off) applies immediately. *(verify
     once prod enables `[auth.email] enable_confirmations`.)*
   - ✅ **Google login** — `linkGoogle` (signup→same uid) / `signInWithGoogle` (signin)
     + "Continue with Google" buttons + a documented (disabled) `[auth.external.google]`
     config. *(enable the provider + set OAuth creds to use.)*

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
- ✅ **Real-DB tests as a CI gate (DONE 2026-06-24)** — `.github/workflows/ci.yml`:
  a `quality` job (typecheck + lint + unit) and an `integration` job that boots
  Supabase and runs the integration suite (RLS, constraints, RPCs, edge I/O shell)
  on every push/PR. JMdict ingest is best-effort (the dict-dependent tests self-skip
  if absent), so the build can't go red on a release hiccup.
- ✅ **Test coverage (DONE)** — `今 / これ / 単語` analyze cases; readings kana-vs-kanji
  switch (`uk`) cases (data-driven); single-word + batch + roundtrip (input=target →
  400) covered in the edge spec. *(Remaining nicety: deeper paragraph-gloss assertions.)*
- ✅ **Code-QA pass (DONE)** — deduped the grade arrays + the `message(e)` helper
  (shared `errorMessage` / `grades`); eslint 0 problems.
- ✅ **"Never show success on a failed write" (DONE — audited clean)** — every
  mutation sets its done/✓ state only AFTER awaiting the write (`AddToListButton`
  flashes ✓ on resolved `onAdd`, reverts on catch; save/review flows all await first).
- ✅ **Leak/security + AI-flaw sweeps (DONE 2026-06-24)** — ran a 37-agent
  multi-agent review (6 dimensions, adversarially verified) → 11 confirmed findings,
  ALL fixed: content-safety bypass on the displayed quiz gloss + blocklist
  inflection/kana gaps; anon/no-JWT MT metering bypass (now deny-by-default) +
  global cap fail-closed; edge raw-error leak on 5xx; `useSession` SIGNED_OUT
  self-heal; homograph candidates resolved by stable entryId; + new cost-control
  (413/429/anon) and homograph/frequency integration tests. (Re-run the review after
  major changes.)

## 🛡 Content safety
- ✅ **Profanity / explicit filter on SUGGESTIONS (DONE 2026-06-24)** —
  `contentSafety.ts` blocklist (per-language, extensible) applied in
  `rankDomainCandidates`; the `stryker→stripper` class is filtered from the word map /
  "Explore related words", while direct lookup stays unfiltered. Unit-tested.

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

## 🚀 Tier 4 — Post-launch new features (input modalities + AI agents)
New capabilities to add AFTER launch (not blockers). Feasibility + cost analyzed
2026-06-25; the throughline is **these are free on-device on native (#18) but
paid/heavy on web**, so they're an argument for the native track over throwaway web
versions. Cross-platform native detail recorded in CLAUDE.md `#18`.
- **Speech-to-text input** — cheapest win. **Web:** Web Speech API (`SpeechRecognition`,
  `ja-JP`) — free, Chrome-only, no infra, no quota; output feeds the existing
  `analyze()` → JMdict pipeline. **Native:** free + on-device + offline on BOTH iOS
  (`Speech`/`SpeechAnalyzer`) and Android (`SpeechRecognizer`, on-device API 33+).
  On-device isn't billed by duration, so silence-trimming/VAD only matters for the
  paid Cloud Speech fallback — skip it unless Web Speech proves insufficient.
- **Camera / OCR (photo → text)** — **Web:** Google **Cloud Vision** `TEXT_DETECTION`
  / `DOCUMENT_TEXT_DETECTION` — $1.50/1k images, first 1k/mo free (verified 2026-06-25);
  cost = per-image (cropping cuts bandwidth/latency, NOT the bill — only fewer images
  does), so gate with a button-triggered capture + a per-user monthly image quota
  (new nullable `user_limits` column, enforced edge-side like `monthlyCharQuota`). OCR
  text then flows into the JMdict-first pipeline (mostly free). Tesseract.js is the
  free-but-rough client-side fallback. **Native:** FREE + on-device — **ML Kit Text
  Recognition v2** (JA model, works on iOS AND Android = one library) + iOS Vision /
  Live Text. No Cloud Vision bill on native.
- **AI agents — generative study aids** `[extends #12 thread E]` — needs an LLM (Claude),
  a NEW cost center: add `ANTHROPIC_API_KEY` as an edge secret + a generations/month
  quota column; same reserve-before-call seam. Cost is tiny (sample sentence ~50–150
  tok, paragraph ~300–500 tok → fractions of a cent on **Haiku 4.5**, Sonnet for the
  domain paragraph). Discipline: **cap `max_tokens` hard** (deterministic per-call
  ceiling) + **cache outputs** (reusable like the `words` cache) + prompt-cache the
  system prompt.
  - **Create sample sentence** — generate an example sentence using a saved word.
  - **Generate a domain paragraph quiz** (instead of the related-words list) — "write a
    short paragraph at level X using these seed words." **Architectural fork:** an LLM
    can COLLAPSE the embeddings work (#11/#12) into one call — less infra + sidesteps
    the katakana-loanword clustering problem, at the cost of ongoing per-use spend +
    less determinism. Weigh LLM-generation vs pgvector when building thread E.
  - **Hybrid (recommended):** embeddings for deterministic, free, level-aware word
    *selection* (word-map nearest-neighbor + frequency filter, runs in Postgres for
    free); LLM only for fluent *generation* ("use as many of these related words as
    possible in a sentence"). You pay BOTH the embedding STORAGE (fixed monthly
    footprint, ~165 MB @ 384-dim — the query itself is free) AND the LLM per-use cost,
    but they're additive-and-both-small: per call ≈ **$0.0017 on Haiku / $0.005 on
    Sonnet** (~700 in + ~200 out tok), i.e. 1,000 generations ≈ $1.70 Haiku / ~$5
    Sonnet. Hard `max_tokens` cap guarantees the ceiling regardless of input size.
    Rates verified 2026-06-25: Haiku 4.5 $1/$5 per 1M in/out, Sonnet 4.6 $3/$15.
  - **⚠️ BILLING CAVEAT — investigate user-billing IN PARALLEL with production.** Every
    item in Tier 4 (LLM, Cloud OCR, Cloud Speech) is a per-use paid feature, so this is
    the point the free tier stops being free. Stand up monetization (paid plan / usage
    quota / Stripe) ALONGSIDE these features, not after — the `user_limits` entitlements
    table + reserve-before-call metering is already the seam (per-user quota columns
    exist); billing is the missing half. Decide free-vs-paid limits before launch so
    cost-bearing features ship behind the entitlement they require.

- **Media ingestion — subtitles/scripts → new words** `[extends #9 extract-and-quiz]` —
  fetch a piece of media's text, run the EXISTING reader/quiz over it (the LLM is NOT the
  scraper — it can't fetch URLs or watch video; this is a fetch pipeline feeding the
  current `analyze → JMdict → extract new words` flow, i.e. #9 fed by media instead of a
  paste). Per-source **ingestion adapter** outputs plain text → reader unchanged. Core is
  FREE (kuromoji + JMdict); LLM/STT are optional paid layers on top.
  - **🌟 "Pre-study a series before you watch" — the flagship mode.** Pull a whole
    episode/season subtitle corpus → extract content words → dedup vs the user's known
    vocab → **rank by frequency** → flashcard the NEW ones (most common first = best
    comprehension ROI). A full episode is the BEST domain signal we can get (CLAUDE.md:
    a short paste is noisy, "a whole episode's subtitles cluster far better") — so this
    is the strongest expression of the #8–#12 "study-the-media-you-love" thread, and it
    reuses #9 + frequency + #10 calibration with no new core infra.
  - **⚠️ The real constraint is JP subtitle SUPPLY, not upload UX.** OpenSubtitles is
    English-dominated; for Japanese, **anime is well-covered (Kitsunekko) but live-action
    JP is scarce** (you often find ENGLISH subs for a JP show, useless for studying JP).
    Since the app is JA↔EN, the source integration is the real enabler, NOT a nice-to-have
    — manual `.srt` upload alone reaches only motivated users + mostly anime/English.
  - **Pre-study does NOT need synced/correct-version subs.** Sync + release-matching only
    matter when overlaying subs on video while watching; for "what words appear in this
    title," ANY transcript works (wrong release, off-by-seconds — fine). This widens
    usable supply and removes the hardest part of normal subtitle-hunting.
  - **Chosen sources (decided 2026-06-25):** **Kitsunekko** = primary (anime JP subs,
    where the JP supply actually lives); **OpenSubtitles API** = MAYBE, pending deeper
    **legality research** (API key + attribution terms — research before committing).
    **User `.srt` upload** = the safe floor, ship it regardless (zero acquisition risk).
  - **YouTube — the clean URL win:** official captions / transcript API (or user-pasted
    transcript). FREE, captions first-class. Do this first alongside `.srt` upload.
  - **Netflix — no public API; server-scraping violates ToS.** The ONLY defensible model
    is the Language-Reactor pattern: a **browser extension** reading the timed-text track
    Netflix already streams to the logged-in user (client-side, tied to a legit session —
    NOT a backend fetch). Different architecture, still ToS-gray → much-later/maybe.
  - **TikTok / Instagram — heavier + gray:** no subtitle endpoint → download audio →
    **speech-to-text** (Cloud Speech / Whisper). Fragile, costs STT, ToS/copyright risk.
  - **⚖️ Legal discipline (makes the whole feature defensible):** **derive word lists;
    NEVER store or redistribute the full script/subtitle text** — exactly the wordfreq
    stance ("ship derived numbers, not the corpus"). Extract vocab + glosses, discard the
    copyrighted text; isolated words + meanings is transformative, reproducing the script
    is not. Also keeps storage tiny. All external-source fetching goes through the
    Privacy/ToS review. **Safest POC scope:** `.srt` upload + YouTube captions; defer
    OpenSubtitles/anime-repos, then Netflix/TikTok/IG.

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
**Throughline:** the v1 ENGINEERING is essentially done — auth (incl. pages, profile,
Google, email-confirm, password rules), content safety, the QA gate (CI + tests +
multi-agent review), and the cost/metering hardening are all in. **What's left to
publish is non-code:** **Deploy (#2, the gate — needs your cloud accounts)**, counsel
review of the drafted Privacy/ToS, and the **Tier 2** console config that Deploy
unlocks. Google + email-confirmation are wired and just need creds / prod
confirmations to verify. **Admin tooling** + Tier 3 are post-launch.

---
## ✅ Completed
Newest first. Dates from CLAUDE.md's verification log + git history. Items here are
DONE (some have minor "remaining" notes tracked in the tiers above).

### 2026-06-25
- **Paragraph reader hovercard scroll fix** — the sense popover was `position: fixed`
  with no height cap, so a word with many senses (or one low in the viewport) ran off
  the bottom unreachable. Now height-capped to available space with internal scroll +
  flips above the word when there's more room there (`ParagraphReader.tsx`,
  `translate.css`).
- **Input-modality + AI-agent feasibility analysis** — costed speech-to-text, camera/OCR,
  LLM study aids (incl. verified Claude rates), the embeddings+LLM hybrid, media
  ingestion (the "pre-study a series before you watch" flagship mode; the JP
  subtitle-SUPPLY constraint + that pre-study needs no synced subs; chosen sources —
  **Kitsunekko primary**, **OpenSubtitles pending legality research**, .srt upload as the
  safe floor; derive-word-lists-not-the-script legal discipline), and the parallel
  user-billing caveat; recorded as Tier 4 + CLAUDE.md `#18`.
- **Docs:** renamed `Launch_Checklist.md` → `TODO.md`; added this Completed log.

### 2026-06-24 — launch-prep day (v1 engineering essentially done)
- **Real auth core (#13)** — email/password accounts + data-preserving guest→account
  upgrade (same `auth.uid()`) + password-reset flow (verified live via Mailpit);
  `AccountMenu` + `ResetPasswordView`.
- **Auth/account UX (#13)** — password-strength policy (server + client); in-house
  router + separate `/signin` `/signup` `/profile` pages; profile page with
  native/learning/app language prefs (`users.native_language`); Google login wiring
  (`linkGoogle`/`signInWithGoogle`); email-confirmation pending state.
- **Legal (§10)** — Privacy Policy + Terms of Service pages (footer-linked, DRAFT
  pending counsel); JMdict/EDRDG + wordfreq attribution notice (#15).
- **Cost-control code (#1)** — MT kill-switch (`MT_DISABLED`) + global monthly spend
  cap (`GLOBAL_MONTHLY_CHAR_QUOTA` / `consume_global_quota`); quota refund + default
  global cap.
- **QA gate** — CI (GitHub Actions: quality + real-DB integration job); analyze +
  `uk` reading-switch test coverage; shared-helper dedup + clean lint; multi-agent
  pre-publish review (37 agents → all 11 confirmed findings fixed); content-safety
  filter on suggestions (not lookup).
- **i18n (#17)** — full EN/JA localization layer + language picker across all surfaces.
- **Ops/observability** — off-site user-data backup + tested restore (`db:backup` /
  `db:restore-test`); health check + request log + MT-spend metric; retry idempotency
  for the paid MT path; vocabulary pagination; clean `supabase db reset` that
  reproduces schema + reseeds dictionary (no re-ingest); embeddings multi-language
  key + frequency-floor policy.
- **Deploy prep (#14)** — prod build verified green; prod `/dict/*.gz` headers
  (`public/_headers`); runbook in `docs/Deploy.md`.

### 2026-06-23
- **Frequency ranking (#7)** — sourced from **wordfreq** (NOT JMdict; verified
  jmdict-simplified has no `nfXX`), Zipf ×100, joined onto `jmdict_kanji`/`jmdict_kana`
  in ingest; `jmdict_lookup` orders by headword frequency. Live-verified (行く, 食べる,
  する). Feeds difficulty (#8) via `services/difficulty`.
- **Extract-and-quiz from pasted text (#9)** — "Quiz N new words" over content words
  not yet in vocab; each grade feeds SRS (`useTextQuiz` → save + `recordReview`).
- **DB performance pass** — see `docs/DB_Performance_Changes_260623.md`.

### 2026-06-20
- **Stable JMdict identity (#1)** — `words` carries `jmdict_entry_id` /
  `jmdict_sense_pos` / direction-aware `dictionary_ref`; edge projection upserts on
  `dictionary_ref` so re-projection UPDATEs in place (fixes the `いく`/`行く` cache fork).
  Verified live; legacy `(input,translation,…)` UNIQUE later dropped.
- **Transactional save (#2)** — `save_dictionary_word` / `create_custom_word` make
  entry-create + sub-list tag one atomic RPC; failed tag rolls back. Verified live.
- **RLS / DB-constraint + RPC integration suite (#5)** — passes live (45/45):
  cross-user isolation incl. two-sided `list_words` ownership, UNIQUE/CHECK/FK/cascade,
  non-Latin/multi-language, and the Postgres functions exercised for real.
- **Production hardening (#4)** — domain error types (`services/errors.ts`); CORS
  env allow-list (`ALLOWED_ORIGINS`); generated DB types (`createClient<Database>`).
- **Projection version stamp (#3)** — `words.projection_version` + cache-staleness
  flagging (active re-projection sweep deferred to admin tooling).

### 2026-06-18
- **JMdict dictionary stack** — self-hosted normalized `jmdict_*` tables + `jmdict_lookup`
  as the primary provider, projected into the lazy `words` cache (readings inline);
  Google MT as fallback. Verified end-to-end on local Supabase (jmdict-eng-common 3.6.2).
  "Usually kana" (uk) headword handling; per-sense reading selection (homograph split).

### Foundational (pre-2026-06-18, exact dates not logged)
- Translate (JMdict + MT) · Lists · Review (SRS forgetting-curve) · client-side
  kuromoji morphological analysis · the differentiator thread scaffolding (#8 difficulty
  · #10 calibration · #11 word map / pgvector embeddings · #12 domain quizzes) · NFC
  hardening · delete-lockdown · anonymous guest auth · the service-layer architecture
  (server-write-only dictionary, per-user vocabulary split).
