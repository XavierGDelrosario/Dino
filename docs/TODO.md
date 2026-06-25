# DINO — TODO (Launch + Roadmap)

The product is built; the gap to publishable is almost entirely non-feature work
(auth, deploy, security, cost, legal). Tags: `[concern]` = a concern raised directly ·
`[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`. This is the REMAINING work;
**everything shipped is logged at the bottom under [Completed](#-completed) with dates.**
(Renamed from `Launch_Checklist.md` → `TODO.md` on 2026-06-25.)

## ✅ Tier 1 — Launch build work: DONE
Tier 0 (security/cost CODE blockers — delete-lockdown, RLS audit, kill-switch +
global cap) and Tier 1 (real auth #13, the full account/auth UX, Deploy #14 — live at
`dino-86y.pages.dev`) are all done; see Completed. The drafted Privacy/ToS counsel
review is **not** a build blocker — moved to Open follow-ups (it isn't urgent while the
app isn't publicly launched).

## 🔒 Tier 2 — Hosted-only (external-console actions on the LIVE prod project)
The app is deployed and the **launch-critical console hardening is DONE (2026-06-26)** —
Supabase auth config, the Google Translation key restriction + budget alert, and the
repo-side secret-scan CI (items 2–4 below). What's left is only the **Pro-gated** items
(Supabase spend cap, automated backups/PITR) deferred while on Free, plus hosted
alerting — none blocking launch.
2. **Prod security config** — `[§4/§5]` ✅ DONE (2026-06-26): `ALLOWED_ORIGINS` = live
   Pages URL + `verify_jwt` ON (deploy script); **Google Translation API key restricted**
   to the Cloud Translation API (application-restriction **None** — it's a server-side
   key called by the edge function, so there's no browser referrer / stable IP to gate;
   the API restriction is the real protection); **secret-scan CI** (gitleaks job in
   `.github/workflows/ci.yml`, scans full history, fails on any committed secret).
3. **Prod auth config** — `[#13 cont.]` ✅ DONE (2026-06-26): Supabase dashboard —
   **Site URL + Redirect URLs**, **email confirmation**, **Google OAuth provider** (creds
   from `.env.deploy`) + manual linking, **anon sign-up rate limit**. All were wired in
   code; these were the console toggles. (Account-linking collisions → Open follow-ups.)
4. **Cost protection — hosted** — `[concern · §3]` anon-signup **rate limit** ✅ DONE
   (Supabase) + **Google Cloud budget alert** ✅ DONE (early-warning email; the hard
   ceiling is the app-level `GLOBAL_MONTHLY_CHAR_QUOTA`). **Supabase spend cap: N/A —
   project is still on the FREE tier** (Free can't overspend; revisit at Pro). Code side
   done (MT kill-switch + global monthly cap).
5. **Forward-only migrations** — `[concern · §11]` now that prod holds data you can't
   `db reset`, adopt the forward-only, never-edit-an-applied-migration discipline
   (process, not a task). Clean-reset reproduction already proven.
6. **Automated backups + PITR** — `[concern · §2]` needs **Pro** (Free has none) — flip
   the paid-tier toggle + schedule `db:backup` off the DB host. Deferred while on Free;
   backup + tested-restore tooling is done. *(Interim safety on Free: run `db:backup`
   manually / on a cron from your own machine.)*
7. **Observability — alerting** — `[§9]` point the edge's structured logs (health /
   request / `mt_spend`, all emitting) at hosted alerting (spend threshold, 5xx,
   uptime). In-code side done.

## 🛠 Admin tooling (operational; build as a gated admin surface)
8. **Admin webpage** — a privileged surface (role-gated; NOT a normal user) for ops:
    - **Edit the `words` dictionary cache** — drive the deferred re-projection sweep
      (see #3 / `projection_version`): flag rows older than `CURRENT_PROJECTION_VERSION`
      as outdated and re-project / merge them (the destructive sweep gated on a test
      harness, per CLAUDE.md).
    - **Usage dashboards** — total + per-user MT usage from `translation_usage` /
      `global_translation_usage`, **anonymized** (no raw email/PII — bucket by user id
      hash) to maintain privacy.
    - **DB usage by table** — `pg_total_relation_size` per table (storage headroom vs
      the tier cap).
    - **Third-party API health** — surface, per external service, the **API-key/credential
      EXPIRY date** and **current USAGE vs quota/free-tier**, so nothing silently lapses or
      caps out. Cover: **Brevo** (email send count / daily limit, SMTP key), **Google
      Cloud** (Translation API key + spend/quota, OAuth client secret expiry), **Supabase**
      (access token, Pro/billing caps), and any future provider (Cloud Vision/Speech,
      Anthropic). Pull via each provider's API where possible; show "expires in N days" +
      "X / limit this period" with a warning threshold. (Several of these creds are rotation
      candidates — see the launch checklist.)
    - **Grant feature privileges (with expiry) — GRANT-ONLY, never revoke.** From the admin
      page, grant a user a feature entitlement (the `user_limits`-style per-user columns:
      raise a quota, unlock voice/camera/LLM) **and set a duration/expiry** for the grant.
      **Hard rule: a granted privilege can be EXTENDED but NEVER taken away** — for legal
      reasons, once we reach the stage where a user has PAID for privileges, removing a paid
      entitlement is not allowed. Model this as append-only grant rows (grant + optional
      future expiry; lapse is by expiry, not deletion) rather than a mutable flag an admin
      can flip off. Server-enforced (service role writes grants; RLS read-own); the active
      entitlement = the union of non-expired grants.
    - **Error-code log (append-only, viewable from the admin page)** — persist every error
      with its **date/time, the error code, and the input** that triggered it, queryable +
      viewable in the admin UI (filter by user / code / date). Append-only audit record so
      failures (esp. on paid features) are traceable after the fact.
    Server-enforced admin role (RLS / a `is_admin` claim); never a client-only gate.

## 🧪 Pre-publish QA gate — STRICT audit before the first published build
A hard gate as we approach v1: do this before going public, not after. **All items
DONE (2026-06-24) — see Completed.** Standing reminder: **re-run the multi-agent
pre-publish review after any major change.**

## 🟢 Tier 3 — Post-launch OK (features / polish)
- native app (#18). *(i18n #17 done — EN/JA; add a locale = one entry in
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
> **⚠️ Scope flag (temporary, financial): ship the input-modality features below
> (speech-to-text, camera/OCR, handwriting) as iOS-ONLY at first.** The free on-device
> path works on BOTH iOS and Android, but maintaining two native builds costs money we
> don't want to spend pre-revenue — so do iOS first, add Android once it's justified.
> This is a delivery-scope decision only, NOT architectural: `analyze()` and the
> services stay platform-neutral, so Android is purely additive later (re-skin the
> views + the per-platform `analyze()` swap noted in CLAUDE.md `#18`).
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
- **Handwriting input ("draw the character")** `[iOS-only first — see scope flag]` —
  finger/stylus stroke-based recognition (Google Translate's "draw" mode), so a learner
  can look up a kanji they can SEE but can't type. Output is plain text → feeds the same
  `analyze()` → JMdict pipeline unchanged (like speech/OCR). **Native (the clean path):**
  Google **ML Kit Digital Ink Recognition** — on-device, FREE, no quota, Japanese
  supported (300+ langs / 25+ scripts); cost is only a ~20 MB per-language model
  download (bundle / wifi-once, like the kuromoji `/dict/` payload). **Web:** no
  supported free Google ink/stroke API — ML Kit is mobile-only; options are the
  unofficial `inputtools.google.com` endpoint (free but undocumented/ToS-gray, can
  break) or rasterize the canvas → **Cloud Vision** OCR (reuses the camera/OCR seam +
  quota, but lower quality for a single drawn char). Canvas stroke capture is trivial;
  *recognition* is the whole problem. **Lowest-priority modality** — typing + IME
  already works, and the camera/OCR path overlaps (photograph the kanji instead of
  drawing it). Analyzed 2026-06-26.
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
- **Legal — Privacy/ToS counsel review** — `[§10]` in-app `/privacy` + `/terms` are
  DRAFTED + footer-linked (real data flows: Supabase storage; Google receives translated
  text; account deletion). Remaining: **counsel review before going truly public**. NOT
  urgent — the app isn't publicly launched yet; get sign-off before a public push, not
  before a private/soft test. (Bump `CURRENT_TERMS_VERSION` in `src/lib/terms.ts` when the
  reviewed copy lands, so the post-login Terms gate re-prompts existing accounts.)
- **English-as-a-learning-target — dictionary QUALITY epic** — `[#11 / secondary market]`
  English ALREADY works as a learning target: it's a selectable language and EN→JA lookups
  resolve via reverse-JMdict (now uk-correct — `this → これ/この`). What's thin is QUALITY,
  and it's mostly RANKING/content, NOT storage — fits the free tier (see the storage note;
  Pro is only forced by English *embeddings*). Cheap-first order:
  1. ~~EN→JA reverse-gloss ranking~~ — done 2026-06-26 (migration `20260702`); see
     Completed. *(The `LIMIT 12` reader-sense tail is still loose — separate item above.)*
  2. **English frequency** (wordfreq EN → `data/frequency/en.tsv`, ~3 MB) so an English word's
     DIFFICULTY uses English frequency, not the matched JA entry's. Needs an `english_frequency`
     lookup applied to EN-source `words` at projection (today EN words inherit the JA entry's
     frequency — wrong axis).
  3. **English lemmatizer** so `ran/running → run` (kuromoji is JA-only; EN uses Intl.Segmenter
     with no lemma).
  4. **(optional) Japanese WordNet (wnjpn)** for richer EN→JA coverage (~20–40 MB, free, fits).
  5. **English embeddings / word-map** (#11) — the storage hog (~80 MB+) and the real Free→Pro
     trigger; until then "Explore related words" is hidden for non-JA learning langs (done).
- **Account-linking edge cases (email ↔ Google, same person)** — `[#13 auth]` partially
  handled. (1) **Sign-up "Continue with Google" uses `linkIdentity`**, which needs
  `security_manual_linking_enabled=true` (was OFF → that path errored); enabling it makes the
  guest→Google upgrade preserve vocab. (2) **Collision: email/password account + later Google
  (same email)** auto-links into one account ONLY if the email is CONFIRMED — an unconfirmed
  account can fork into two with split vocab. (3) **Google account first, then email/password
  signup** → `updateUser` errors "email already registered" with no UI path to set a password
  on the Google account. (4) **Guest with words → sign-in-page Google** switches uid → guest
  words don't carry (sign-in ≠ upgrade), surprising. TODO: clear messaging on collision
  ("this email already signs in with Google — use that"), a claim/merge story, and a decision
  on guest-data carry for the sign-in Google path. Verify the auto-link behavior live.
- **Source-language mismatch robustness** — `[translate UX]` when the user sets a CONCRETE
  source language that clearly doesn't match the typed text's script (e.g. source = Japanese
  but the input is plain Latin/English), the flow produces garbage (MT echoes the input,
  reader shows un-looked-up words). The default "Detect language" source works; this only
  bites a manual mismatch. Fix: in `resolveSourceLanguage` (or `useTranslate.submit`), if
  `detectLanguage(text)` strongly disagrees with the selected source on SCRIPT (kana/kanji
  vs Latin — unambiguous), override to the detected language (or warn). Low-risk: only fires
  on a definite script mismatch, never on a plausible one.
- **Dedicated app email + sending domain** — `[launch polish]` right now BOTH the Google
  OAuth support address AND the Brevo SMTP sender are the founder's PERSONAL gmail
  (`xaviergdelrosario@gmail.com`). Create a dedicated app mailbox (e.g. a fresh
  `dino…@gmail.com`, or `noreply@<domain>` once a domain exists) and point Google's consent
  support email + Brevo sender at it. Tied to the custom-domain item: a domain enables
  `noreply@dino.app` WITH SPF/DKIM, which is also what fixes deliverability (without it,
  single-sender Brevo mail can land in spam) — so doing the domain solves email branding,
  deliverability, the app URL, and the Google `…supabase.co` text together.
- **Custom domain + branded auth** — `[launch polish]` prod is on the default
  `dino-86y.pages.dev` (Cloudflare appends a random suffix to every new Pages
  subdomain — a clean `dino.pages.dev` isn't obtainable) and Google's consent screen
  shows "Sign in to <ref>.supabase.co". Both are cosmetic; login + app work. To fix at
  real launch: (1) register a domain (~$10/yr) → attach to Cloudflare Pages (free) for a
  clean app URL — also update Supabase Auth Site URL/redirects + the edge `ALLOWED_ORIGINS`
  + Google authorized origins/redirects to the new domain; (2) for the Google branding,
  add a Supabase **custom auth domain** (`auth.<domain>`) — requires **Pro** ($25/mo).
  Interim done: Google consent **App name = DINO** (free; shows "continue to DINO").
- **Complete account deletion** — `[Tier 1 / #13]` `delete_account()` erases this
  app's PUBLIC-schema data but NOT the Supabase `auth.users` row; pair it with the
  auth admin API when real auth lands, else deleted users can still sign in.
- **Real furigana (#16)** — *very low priority.* Ruby above the kanji + peel-matching-
  kana alignment (`alignFurigana`); group ruby is correct meanwhile.
- **FSRS (#19)** — *very low priority.* Upgrade the SRS to the D/S/R model (power-law
  curve, fit constants to `review_log`); a new `record_review()` body, same API. The
  HLR curve is fine for now.

---
**Throughline:** the v1 ENGINEERING is done and **the app is DEPLOYED** (live at
`dino-86y.pages.dev`) — auth (pages, profile, Google, email-confirm, password rules),
content safety, the QA gate (CI + tests + multi-agent review), and the cost/metering
hardening are all in. **What's left to publish is non-code:** counsel review of the
drafted Privacy/ToS (Tier 1), and the **Tier 2** external-console hardening on the live
project (CORS/JWT verify, Google-key restriction, auth toggles, billing caps, backups,
alerting). **Admin tooling** + Tier 3 are post-launch.

---
## ✅ Completed
Newest first. Dates from CLAUDE.md's verification log + git history. Items here are
DONE (some have minor "remaining" notes tracked in the tiers above).

### 2026-06-26
- **Prod auth config (Supabase dashboard)** — on the live project: **URL Configuration**
  (Site URL + Redirect URLs for reset/confirm links), **email confirmation** enabled,
  **Google OAuth provider** enabled (creds from `.env.deploy`) + manual linking, and the
  **anonymous sign-up rate limit**. (Account-linking collision edge cases still in Open
  follow-ups.)
- **Production deploy (#14)** — app **live at `dino-86y.pages.dev`** (Cloudflare Pages)
  on hosted Supabase (Free + common JMdict). `scripts/deploy-prod.sh` ran the full
  pipeline: link + migrations + dictionary seed, edge functions (`translate` +
  `delete-account`, `verify_jwt` ON), edge secrets (`TRANSLATION_API_KEY`,
  `GLOBAL_MONTHLY_CHAR_QUOTA`, `ALLOWED_ORIGINS` via `lockdown`), and the Cloudflare
  build/upload. Remaining hardening = external-console toggles tracked in Tier 2.
- **EN→JA verb-gloss ranking (epic item 1)** — migration
  `20260702_en_ja_verb_ranking.sql`: head-match regex allows an optional leading `to `
  (`^(to )?<input>`), so infinitive verb glosses head-match — `do → する/やる/行う`,
  `eat → 食べる` rank correctly instead of by raw frequency. Zero new storage.
- **Explore-related hidden for non-JA learning languages** — the word-map (pgvector
  embeddings) exists only for JA, so "Explore related words" is gated to
  `learning === "JA"` (`TranslateView.tsx`); re-enable per language as embeddings ship.

### 2026-06-25
- **Post-login Terms gate** — `TermsGateView` takeover (`App.tsx`, gated on
  `needsTermsAcceptance`): a permanent account whose `terms_version` is NULL/behind
  `CURRENT_TERMS_VERSION` must accept before using the app. Closes the Google-signup
  bypass + re-prompt-on-update; guests never gated; fails open on a check error.
- **Per-account Terms acceptance + DINO branding** — `users.terms_version`/agreement
  stamp (migration `20260630`); guest profile hidden; DINO consent-screen branding.
- **Complete account deletion** — `/delete-account` page + header-menu entry (erases
  public-schema data; the `auth.users` row still pairs with the auth admin API — see
  the open follow-up).
- **Globe app-locale menu** — in-header language picker for the UI locale (i18n).
- **Translate UX** — show the translation immediately, stream the reader in below
  (`f1ef78a`); echo the input when source language == target (`433200e`).
- **Review-from-Lists** — clicking Review on a filtered Lists view quizzes only the
  filtered words (`f975295`).
- **kuromoji prod fix** — gunzip the dict via an `fflate` shim, fixing the prod
  paragraph-reader hang (`cb0e2b1`).
- **CI/QA** — browser e2e smoke test against the prod build (`06a9c64`); run CI on
  Node 22 (supabase-js 2.108 needs native WebSocket); qa-audit fixes (default study
  reader, legal docs while gated, gate race, CI skip).
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
