# DINO — TODO (Launch + Roadmap)

Remaining work only. Tags: `[concern]` raised directly · `[#N]` roadmap item ·
`[§N]` `Production_Hardening.md`.



## 🔒 Tier 1 — Hosted-only (external-console actions on the LIVE prod project)
The console-hardening items 2–4 are handled. Remaining below — none blocking launch (item
numbers preserved; cross-referenced elsewhere):
5. **Forward-only migrations** `[concern · §11]` — prod holds data you can't `db reset`; never edit an applied migration (process, not a task). Clean-reset reproduction proven.
6. **Automated backups + PITR** `[concern · §2]` — needs **Pro** (Free has none): flip the toggle + schedule `db:backup` off the DB host. Backup + tested-restore tooling done. *(Free interim: run `db:backup` manually/cron from your machine.)*
7. **Observability — alerting** `[§9]` — point the edge's structured logs (health/request/`mt_spend`, all emitting) at hosted alerting (spend, 5xx, uptime). In-code side done.

## 🛠 Admin tooling (gated admin surface; operational)
8. **Admin webpage** — role-gated ops surface (server-enforced `is_admin`, never client-only; logging tables service-role-write / admin-read):
    - **Edit `words` cache** — drive the deferred re-projection sweep (#3 / `projection_version`): flag rows < `CURRENT_PROJECTION_VERSION`, re-project/merge (destructive sweep gated on a test harness, per CLAUDE.md).
    - **Usage dashboards** — total + per-user MT from `translation_usage`/`global_translation_usage`, anonymized (bucket by user-id hash, no PII).
    - **DB usage by table** — `pg_total_relation_size` (storage headroom vs tier cap).
    - **Third-party API health** — per service, credential EXPIRY + USAGE vs quota, so nothing silently lapses/caps: **Brevo** (send count, SMTP key), **Google Cloud** (Translation key spend/quota, OAuth secret expiry), **Supabase** (access token, billing caps), future (Cloud Vision/Speech, Anthropic). Show "expires in N days" + "X/limit" with warning thresholds. (Several are rotation candidates.)
    - **Grant feature privileges (with expiry) — GRANT-ONLY, never revoke.** Grant a `user_limits`-style entitlement (raise quota, unlock voice/camera/LLM) + a duration. **Hard legal rule: a granted privilege can be EXTENDED but NEVER removed** (once paid, you can't take it away). Model as append-only grant rows (lapse by expiry, not deletion), not a flippable flag. Server-enforced; active entitlement = union of non-expired grants.
    - **Error log** (append-only, filterable) — per error: timestamp, code, MESSAGE, the INPUT, user id, surface/endpoint. Traceable failures, esp. on paid features.
    - **Translation/MT call log** — per request: input length, resolved path (JMdict·WordNet·MT), cache hit/miss, est. cost, latency, anonymized user. Persist the edge's `mt_spend`/request stream so spend + provider mix are QUERYABLE.
    - **Quota/limit-hit events** — log every 413 (over `paragraphCharLimit`) and 429 (`monthlyCharQuota` / `GLOBAL_MONTHLY_CHAR_QUOTA` / `MT_DISABLED`), with which cap + user — to tune caps + spot abuse before it costs.
    - **Auth/account audit** — append-only sign-up / upgrade / sign-in/out / reset / deletion (who+when, never passwords).
    - **Admin-action audit** — every privileged action (grant, re-project, prune) with acting admin, target, action, time. The surface must audit ITSELF (critical given the never-revoke rule).
    - **Content-safety blocks** — log `isExplicitSuggestion` filters (input + where) to monitor false pos/neg + abuse.
    - **Edge health/latency** — surface emitted health/request logs (p50/p95, status mix, 5xx) — the in-app half of Tier 1 #7.
    - **Log retention + PRIVACY** — raw-input logs are PII: retention window (prune like `idempotency_keys`), admin-only read (RLS), bucketed user ids in aggregates. Decide per-log how long raw input lives vs. reduced to hash/length.

## 🐞 Remaining bugs, scalability & hardening

### Scalability
- **EN→JA reverse-gloss heavy query** — regex-over-trigram scan + ~5 correlated
  subqueries/candidate; cache-absorbed but CPU-heavy on full prod JMdict. Materialize a
  flat `gloss_terms(term, entry_id, rank)` (btree on `term`) + denormalize
  headword/reading/freq. (`20260618_jmdict.sql`.)

### Test coverage
- **Hooks — DONE 2026-07-03.** `useLists`, `useReview`, `useTextQuiz`, and `useTranslate`
  (applyReview + the input=learning/output=native default) now have RTL `renderHook` specs
  (`tests/hooks/`, jsdom via a per-file `@vitest-environment` docblock; +24 tests in the default
  green gate). Added devDeps `@testing-library/react` + `@testing-library/dom` + `jsdom`. Service
  boundary mocked; `useLists` mocks `USER_WORDS_PAGE_SIZE` small to exercise batch streaming + the
  suppressedIds stream/mutation race guard.
- **Edge error-log — sink contract DONE 2026-07-03; end-to-end trigger still open.**
  `tests/integration/error-log.integration.test.ts` (gated, VERIFIED live 5/5) asserts the
  `error_log` audit contract `recordError` writes to: service-role insert + read-back, row
  immutability (service role can't UPDATE/DELETE), anon SELECT/INSERT lockout, and
  `admin_error_log` denying a non-admin (42501). **Not covered:** driving an ACTUAL failing edge
  path (translate_batch_failed / words_upsert_failed / translate_handler_crashed) to observe the
  row land — those internal failures aren't deterministically forceable over HTTP; fold into the
  native/edge `functions.invoke` integration item if a forcing seam is added.

### Security & architecture hardening (2026-06-28 audit)
Remaining, prioritized:
- **[ops] Rotate the Google Translation key** in `supabase/functions/.env`. BOUNDED
  (already API-restricted + `GLOBAL_MONTHLY_CHAR_QUOTA`-capped) → hygiene; keep it only in
  `supabase secrets`/local dev.
- **[MED] CAPTCHA for anon + email signup** — IP rate-limit is on, but a
  rotating-IP sybil can still bloat `auth.users` (paid MT stays capped). Add
  Turnstile/hCaptcha + a periodic sweep of empty guests (0 `user_words`).
- **[MED · scale-only] Global-quota advisory lock** — reserved once per batch; the
  once-per-request contention only bites at huge MT throughput → shard by hash bucket /
  lock-free UPDATE if it does.
- **[LOW] `public.users.email` client-writable + unverified** — enables squatting; it's
  the lookup key in `admin_grant_feature`. Fix = BEFORE INSERT/UPDATE trigger requiring
  `email` = verified `auth.users.email` OR `<uid>@guest.dino`. DEFERRED: on the
  session-create write path → needs an integration pass (squat rejected; guest + upgrade
  still pass) before prod.
- **[LOW] UI may render raw DB messages** — render copy from the error `kind`; keep
  `.message` for telemetry only.
- **[LOW] CORS defaults to `*`** when `ALLOWED_ORIGINS` unset — prod sets it;
  default-to-deny hygiene (`_lib.ts` + `delete-account`).
- **[LOW] Confirm `idempotency_keys` prune cron** registered on prod (`20260712` no-ops
  without pg_cron).
- **[LOW] Memoize recognizer availability** — handwriting/speech re-hit the native bridge
  each check; cache per session like `analyze.ts`.

**Native runtime + live backend is UNtested (2026-06-28).** A CapacitorHttp regression
HUNG `supabase.functions.invoke` on iOS (stuck on "Translating…"); no test caught it — the
bug lives between three layers each tested with the others stubbed: `client.test.ts` MOCKS
`invoke`; `translate-edge.integration.test.ts` hits the edge via raw `fetch` (Kong rewrites
CORS to `*`); `e2e-smoke.mjs` MOCKS Supabase in desktop Chromium. So `invoke` never runs
for real, nothing runs in the WebView, prod CORS is only real in prod. Every native bug this
session lived here. Fixes, cheapest-first:
- **[DONE 2026-06-29] Prod preflight/health smoke** — `scripts/preflight-smoke.mjs`
  (`npm run smoke:prod -- <pages-url>`): OPTIONS-preflights the live `translate` fn per origin
  (web + `capacitor://localhost`) asserting each is ECHOED (not `*`/`null`), a negative check that
  an unlisted origin is refused (catches an unset `ALLOWED_ORIGINS` → wide-open `*`), and an
  anonymous-sign-in → authed POST→200 with a translation (the live `invoke` path nothing else
  covers). `deploy-prod.sh lockdown` prints the invocation. The CORS asserts are meaningful only
  against PROD (local Kong rewrites to `*`).
- **[DONE 2026-07-05] Integration test via REAL `functions.invoke`** (not raw fetch) vs
  local Supabase. `tests/integration/translate-invoke.integration.test.ts` (gated) drives the
  actual `supabase.functions.invoke` — both the raw SDK seam (auth-token attachment,
  body (de)serialization, non-2xx→`error` mapping) AND the real `client.ts` wrapper
  (`translate`/`translateBatch` → `invokeTranslate` → invoke → result mapping) — against a
  running local edge. Closes the "`invoke` never runs for real" gap (client.test.ts MOCKS
  invoke, translate-edge uses raw fetch, e2e-smoke mocks Supabase). Does NOT cover the
  CapacitorHttp layer itself (still the native-simulator smoke below). **Side-fix:**
  `vitest.config.ts` `test.env` hardcoded `VITE_SUPABASE_ANON_KEY=test-anon-key`, which
  OVERRODE the launcher's real key — so the whole integration suite was silently running with
  an invalid anon key under `npm run test:integration`. Now falls back to the placeholder only
  when real creds aren't supplied (unit gate unchanged). *Live network assertions verified via
  collection/typecheck only in-session — run with `supabase start` + `functions serve` to
  exercise them.*
- **[LOW→big] Native simulator smoke** (XCUITest/Appium): launch → type → assert a
  translation renders — the only layer exercising CapacitorHttp + invoke + real CORS
  together. Until justified, keep a manual device checklist.

### Dictionary ranking / cache (2026-06-28)
Wrong primaries on JA→EN single-word lookups (vs full local JMdict). The remaining case is a
DATA LIMITATION:
- **前→ぜん (want まえ), もの→者 (want 物) — DATA LIMITATION.** Ranking freq is per-SURFACE,
  so a reading is polluted by the kanji's OTHER reading (者's kanji-freq 620 from しゃ > 物
  545; まえ 169 < ぜん 375, ぜん shared by 全/善/前). Surface freq can't prefer the
  learner-default. Fix needs per-(kanji,reading) frequency (wordfreq lacks it) OR a curated
  default-reading/word override (こと→事 already wins via uk). → **A CAPPED hand-verified
  override SHIPPED 2026-07-03 (see below); a blanket curated list was RULED OUT by research.**

**Troublemaker list (researched 2026-06-28, full JMdict; severe = obscure beats everyday):**
- **SEVERE:** ところ→野老 (rare yam) vs 所; はし→階/きざはし (archaic) vs 橋/箸/端; かみ→上 vs 紙/神/髪.
- **Wrong reading (kanji):** 前→ぜん (まえ); 形→なり (かたち); 市→いち (し); 主→おも (ぬし/しゅ); 重→主[おも] (重い); 角→かく (かど).
- **Wrong word (kana):** もの→者 (物); かえる→変える (帰る also wanted).
- **Borderline (OK today):** 後→あと, 方→かた, 生→なま, あつい→熱い (vs 暑い), 月→つき.

**Single-word reading override — RESEARCHED + SHIPPED (2026-07-03).** The plan was a
curated default-reading list; research (kuromoji over a Japanese-Wikipedia corpus × full-JMdict ×
live `jmdict_lookup`) RULED OUT a blanket list and every cheap variant, and shipped a small
hand-verified stopgap instead:
- **A blanket curated list is INSUFFICIENT.** The ambiguous-reading universe is **~4,169 frequent
  words** (≥2 readings, Zipf≥2.5) — measured, vs the ~15-20 hand list. Coverage is unbounded,
  subjective, AND many are context-dependent (日=ひ/にち) with no single correct default.
- **Data-driven per-reading frequency (v1) has the right signal but leaks noise** — a lone-kanji
  token's corpus reading reflects kuromoji's own prior + non-word usages (間 showed ま at 96%
  though あいだ is the everyday word), plus name/register readings (明→あきら, 日本→にっぽん).
- **A `common`-flag guard (v2) FAILED — measured anticorrelated:** it suppressed the genuine fixes
  (前/市/彼 — both readings are flagged common) while letting name/register readings through.
- **What SHIPPED:** `src/services/language/readingOverrides.ts` — a CAPPED, hand-verified set (10
  entries: 前→まえ, 人→ひと, 本→ほん, 彼→かれ, 娘→むすめ, 形→かたち, 頭→あたま, 秋→あき, 裏→うら, 字→じ) of
  common STANDALONE words with a SINGLE everyday reading the system gets wrong. Applied in
  `lookupWord` (`applyReadingOverride`, reorders the PRIMARY sense only; no migration/schema).
  Deliberately EXCLUDES compound-only (数→すう vs the standalone かず), genuinely-ambiguous
  (間 あいだ/ま), already-fine (日本→にほん), and names. Extend by hand only.
- **STILL open (the general no-context case):** genuinely ambiguous single-kanji lookups have no
  clean default — the right long-term UX is a **multi-reading display** (show the top 2-3), not one
  guessed default; the context-aware reader (kuromoji) already handles words in a sentence.

**Reported gaps (2026-07-03, VERIFIED) — from the run `主に大規模次男女婚活傷む`:**
Verified against raw kuromoji (IPADIC in `node_modules/kuromoji/dict`) + the committed common
JMdict subset (`jmdict-eng-common-3.6.2.json`, 22.6k entries). Findings by ROOT CAUSE — most are
SEGMENTATION, not the reading-override work (same class as 唐揚げ: IPADIC has no whole-word token
for the compound, so each fragment is looked up alone and the meaning is lost):
- **大規模 (SEGMENTATION only):** kuromoji splits 大(ダイ)＋規模. JMdict *has* 大規模 (だいきぼ,
  "large-scale") — so fixing segmentation resolves it fully. Dictionary is fine.
- **主に (SEGMENTATION only):** kuromoji peels the adverbializing 助詞 に off → 主(オモ)＋に, so the
  reader looks up bare 主 (ぬし/しゅ/おも), not the adverb. JMdict *has* 主に (おもに, "mainly").
  (The bare-主 reading オモ itself is fine here; the miss is the split adverb.)
- **次男 (SEGMENTATION → cascaded WRONG READING):** standalone 次男 tokenizes correctly (one token,
  ジナン, and JMdict has it). But IN THE RUN kuromoji splits 次(ジ)＋男女(ダンジョ). The exposed bare
  次 then hits the reader's dictionary-reading override (`translateParagraph`: surface==lemma AND
  senses agree on ONE reading) which swaps kuromoji's contextual ジ for standalone 次's dictionary
  reading つぎ — the wrong つぎ the user saw. NOT per-surface-frequency pollution; the trigger is
  the segmentation split, the つぎ is the override firing on a fragment that shouldn't exist.
- **婚活 (SEGMENTATION *and* genuinely MISSING):** kuromoji splits 婚＋活, AND 婚活 is absent from the
  common JMdict subset (0 entries — neologism). Even with segmentation fixed it needs the FULL dict
  or MT. The only double-gap in the run.
- **傷む (NOT missing — secondary-writing lookup issue):** kuromoji is clean (one verb, いたむ) and
  JMdict *has* it — but as the SECONDARY writing of entry 1432710 whose PRIMARY kanji is 痛む
  (kana いたむ; glosses incl. "to be spoiled/damaged"). So "didn't show up" is NOT a missing entry;
  it's how `jmdict_lookup`/the projection handles a query that matches a non-primary writing (likely
  returns/caches under the headword 痛む, so the 傷む surface doesn't render). Verify against live
  `jmdict_lookup('傷む', …)` — Docker/Supabase was down at verify time, so only the JSON was checked.
- **男女→だんじょ:** fine (kuromoji 男女/ダンジョ, JMdict has it). Not a gap.
- **Takeaways:** (1) 大規模/主に/婚活/次男-in-run are all SEGMENTATION failures — a kuromoji
  user-dictionary (or compound-aware pass) fixes them, NOT the curated reading override. (2) 傷む is a
  SECONDARY-WRITING projection bug worth its own check. (3) 次→つぎ is a *consequence* of segmentation
  + the single-reading override, so guard the override against orphaned single-kanji fragments.

**FIXES SHIPPED 2026-07-03 (verified live):**
- **SEGMENTATION → DONE (compound-merge pass).** kuromoji.js has no user-dictionary API, so
  `services/language/compounds.ts` re-merges over-segmented whole words AFTER tokenizing (a curated
  `JA_COMPOUNDS` list + longest-match merge; reading = concatenated fragment readings). Wired into
  `analyzeJapanese`. Verified via real kuromoji: 大規模→だいきぼ, 婚活→こんかつ, 主に→おもに as ONE token
  (`tests/services/language/compounds.test.ts`, 9 tests). Extend by adding surfaces to the list.
  婚活 is still absent from the common JMdict subset (resolves via full dict / MT), but is now ONE
  token so MT gets 婚活, not 婚+活.
- **傷む SECONDARY-WRITING → DONE (migration 20260715).** Root cause (verified live): `jmdict_lookup`
  returned the PREFERRED kanji 痛む for a 傷む search, and the edge's `groupByInput` (input===term OR
  input_reading===term) then couldn't attribute the row to 傷む → the token got zero senses → grey.
  Fix: when the input IS one of the entry's kanji writings, headline THAT writing (+ its own
  frequency); a kana search still surfaces the preferred kanji (ねこ→猫). `jmdict_lookup_many`
  delegates, so the reader's batch path inherits it. Covered by `rpc.integration.test.ts`.
- **STILL OPEN:** the 次→つぎ single-reading override guard (takeaway 3) and the curated default-reading
  override (前→まえ / もの→物, the item above) — not addressed here.

**Remaining dictionary/reading work:**
- **EN long-tail irregulars** — ingest Princeton `verb.exc`/`noun.exc` (the bundled
  `lemmaCandidates` map is common forms only); optionally push EN lemmatization into SQL
  (`wordnet_en_ja_lookup`) so the raw function lemmatizes too, then un-skip the SQL-level spec.
- **Counter polish** — inline furigana ruby rendering (reading data is ready); the rare
  specialist-counter tail; context-variant number readings (4=よん/し/よ).
- The **server-side default-sense override** (前→まえ, もの→物) is the 前/もの item above.

## 🟢 Tier 3 — Post-launch (features / polish)
- **Purge dev/test guests before the first real DB** — trivial one-time `DELETE` (current
  anon rows are throwaway). Run any time before publishing. (Ongoing guest-reaping only
  matters once there's public traffic.)
- **EN→JA reader sense quality** — the Japanese WordNet synset layer leads EN→JA (gloss =
  fallback); remaining polish: live-verify synset grouping + tune the fallback merge size.
- **Embeddings (#11) follow-ups:**
  - entry-level vectors blend homographs + leak gloss-string artifacts — consider per-sense /
    writing-weighted embedding.
  - **e5-large upgrade** — katakana loanwords cluster by SPELLING not meaning (ストライカー→
    streaker/stripper). Fix = stronger model (e5-large 1024-dim / LaBSE); needs the
    `vector(384)` column migrated + full re-embed (~2GB model).
  - **re-embed under the frequency-floor policy** — live vectors are the old `--common-only`
    22.6k; the default (`EMBED_FREQ_FLOOR`, common ∪ freq≥250 ≈ 41k) applies only after
    re-embed + `npm run db:dump-seed`.
  - **English as a learning target** — word map is JA-only. The embeddings key is already
    multi-lang (`(source_lang, dictionary_ref)`) and `build-embeddings.py` has a `--source-lang`
    seam; a non-JA language still needs its own dictionary source + `<source>_lookup()` +
    per-source `related_words`.
  - prod-DB regen at deploy + HNSW tuning under load; per-language KO/ZH.

## 🚀 Tier 4 — Post-launch new features (input modalities + AI agents)
After launch, not blockers. Analyzed 2026-06-25; throughline: **free on-device on native
(#18), paid/heavy on web** — an argument for the native track. Native detail in CLAUDE.md `#18`.
> **⚠️ Scope (temporary, financial): ship the input modalities (speech, camera/OCR,
> handwriting) iOS-ONLY first.** The free on-device path works on both, but two native builds
> cost money pre-revenue. Delivery-scope only, NOT architectural (`analyze()` + services stay
> platform-neutral → Android is additive later).
**Build order (2026-06-27): handwriting → speech-to-text → camera/OCR → AI agents → media
ingestion.** (Product priority, not cost — all three input modalities are free on-device
native; handwriting leads as the most distinctive modality.)

- **Handwriting ("draw the character")** `[iOS first]` — stroke recognition so a learner can
  look up a kanji they can see but can't type; output = plain text → existing
  `analyze()`→JMdict pipeline. **Native:** Google **ML Kit Digital Ink** — on-device, FREE, no
  quota, JA supported; cost = a ~20 MB per-language model (bundle/wifi-once, like kuromoji's
  `/dict/`). **Web:** no free Google ink API (ML Kit is mobile-only) — either the unofficial
  `inputtools.google.com` (ToS-gray, can break) or rasterize canvas → **Cloud Vision** OCR
  (reuses the camera/OCR seam + quota, lower quality). Stroke capture is trivial; recognition
  is the problem.
- **Speech-to-text** — cheapest win. **Web:** Web Speech API (`ja-JP`) — free, Chrome-only, no
  infra. **Native:** free + on-device + offline, both iOS (`Speech`/`SpeechAnalyzer`) and
  Android (`SpeechRecognizer`, API 33+). On-device isn't billed by duration, so VAD/silence-trim
  only matters for the paid Cloud Speech fallback.
- **Camera / OCR (photo → text)** — **Web:** Google **Cloud Vision** TEXT/DOCUMENT_TEXT_DETECTION
  — $1.50/1k images, first 1k/mo free (verified 2026-06-25); cost is per-image (cropping cuts
  latency NOT the bill) → gate with button-capture + a per-user monthly image quota (new
  `user_limits` column, edge-enforced like `monthlyCharQuota`). Tesseract.js = rough free
  fallback. **Native:** FREE on-device — **ML Kit Text Recognition v2** (one library,
  iOS+Android) + iOS Vision/Live Text.
  - **Mode A (photo → reader) is live on iOS** (Apple Vision `TextOcrPlugin.swift` behind
    `services/ocr`; per-line boxes captured for Mode B; still needs device verify). Follow-ups:
    - **Vertical (縦書き) — phase 2.** Mode A's row-bucket sort is HORIZONTAL only; vertical
      scrambles order. Detect by block geometry (tall lines, stacked) → columns x DESC,
      within-column y ASC. Words still recognize; only order is off. (`readingOrder.ts`.)
    - **Mode B — image overlay (AR).** Keep the photo, overlay translations on each box (boxes +
      size already returned). T1: tappable chips at each box (scale img→display, handle EXIF) →
      tap opens the word. T2: "replace in place" (sample bg, draw fitted translation) —
      polish-only. New view on `captureResult()`'s `OcrResult`; geometry already flows.
- **AI agents — generative study aids** `[extends #12]` — needs an LLM (Claude), a NEW cost
  center: `ANTHROPIC_API_KEY` edge secret + a generations/month quota, same reserve-before-call
  seam. Cost tiny (~50–500 tok → fractions of a cent on **Haiku 4.5**). Discipline: hard
  `max_tokens` cap + cache outputs (like `words`) + prompt-cache the system prompt.
  - **Create sample sentence** using a saved word.
  - **Generate a domain paragraph quiz** — "write a short paragraph at level X using these seed
    words." **Fork:** an LLM can COLLAPSE the embeddings work (#11/#12) into one call — less infra
    + sidesteps katakana clustering, at ongoing per-use cost + less determinism. Weigh LLM vs
    pgvector when building thread E.
  - **Hybrid (recommended):** embeddings for free, deterministic, level-aware word *selection*
    (Postgres NN + freq filter); LLM only for fluent *generation*. Pay both embedding STORAGE
    (~165 MB @ 384-dim, query free) + LLM per-use — both small: ~**$0.0017 Haiku / $0.005
    Sonnet** per call (~700 in/~200 out), i.e. 1k gens ≈ $1.70/$5. Hard `max_tokens` guarantees
    the ceiling. Rates (2026-06-25): Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15 per 1M in/out.
  - **⚠️ BILLING — stand up monetization IN PARALLEL.** Every Tier 4 item (LLM, Cloud
    OCR/Speech) is per-use paid → this is where Free stops being free. Build the paid plan /
    quota / Stripe ALONGSIDE: the `user_limits` + reserve-before-call seam exists; billing is
    the missing half. Decide free-vs-paid limits before launch.

- **Media ingestion — subtitles/scripts → new words** `[extends #9]` — fetch media text, run
  the EXISTING reader/quiz (the LLM is NOT the scraper — this is a fetch pipeline feeding #9).
  Per-source **adapter** → plain text → reader unchanged. Core FREE (kuromoji+JMdict); LLM/STT
  optional.
  - **🌟 "Pre-study a series before you watch" — flagship.** Whole episode/season subs →
    content words → dedup vs known vocab → **rank by frequency** → flashcard the NEW ones (common
    first = best ROI). A full episode is the BEST domain signal (vs a noisy short paste) — the
    strongest expression of the #8–#12 "study-the-media" thread; reuses #9 + frequency + #10, no
    new core infra.
  - **⚠️ The real constraint is JP subtitle SUPPLY.** OpenSubtitles is EN-dominated; for JP,
    anime is well-covered (Kitsunekko) but live-action is scarce (you often find ENGLISH subs for
    a JP show — useless). Source integration is the real enabler; manual `.srt` reaches only
    motivated users.
  - **Pre-study needs no synced/correct-version subs** — sync only matters for overlay-on-video;
    for "what words appear," ANY transcript works. Widens supply, removes the hardest part.
  - **Sources (2026-06-25):** **Kitsunekko** primary (anime JP); **OpenSubtitles API** MAYBE
    (pending legality research — key + attribution); **`.srt` upload** = safe floor, ship
    regardless. **YouTube** captions/transcript API = the clean URL win (FREE), do first with
    `.srt`. **Netflix** — no API; only defensible path is the Language-Reactor pattern (a browser
    extension reading the timed-text track of the user's own session, client-side) →
    much-later/maybe. **TikTok/IG** — no sub endpoint → download audio → STT; fragile, costs, gray.
  - **⚖️ Legal:** **derive word lists; NEVER store/redistribute the full script** (the wordfreq
    stance). Extract vocab+glosses, discard the text — transformative, and keeps storage tiny. All
    fetching goes through Privacy/ToS review. **Safest POC:** `.srt` + YouTube; defer the rest.

## ➕ Open follow-ups (slot into tiers as you go)
- **Separate staging DB for iOS dev-device builds** `[concern · dev-env]` — `ios:build` is
  hardcoded to **PROD** (a phone can't reach the Mac's `127.0.0.1`; web `npm run dev` uses
  local), so every on-device sign-up/save/review/guest + any paid-MT lands in prod. Low-stakes
  today (trivial pre-launch data; RLS + cost guardrails; only the public publishable key is
  baked) but a real hazard with real users. App-data half of Tier 1 #5. **Fix: a dedicated
  staging Supabase project** (Free) the dev build points at — isolated, real-device-reachable,
  `db reset`-able. Setup: migrations + `ingest:jmdict`/`ingest:wordnet`/frequency ETL + edge
  secrets + a staging Google OAuth client, then parameterize `build-ios.sh` by project ref.
  *(Interim: the iOS **Simulator** reaches `127.0.0.1` so a local build runs isolated there —
  but it can't exercise on-device speech/camera/handwriting, the point of the native build.)*
- **Legal — Privacy/ToS counsel review** `[§10]` — `/privacy` + `/terms` DRAFTED + footer-linked
  (real flows: Supabase storage; Google gets translated text; deletion). Remaining: **counsel
  review before going truly public** (not urgent pre-public). Bump `CURRENT_TERMS_VERSION` in
  `src/lib/terms.ts` when reviewed copy lands (re-prompts the Terms gate).
- **Proficiency label axis (JLPT/CEFR) — DATA PIPELINE DONE, features TODO** `[#8 sibling]` —
  see **`docs/Proficiency.md`**. The curated per-word level badge ("N3"/"B2"), a SEPARATE axis
  from frequency-difficulty. Built + verified on local: `words.proficiency_band` (+ jmdict source
  cols, migration `20260716`), `data/proficiency/ja.tsv` (JLPT, MIT/Tanos, 7.8k surfaces, 99.3%
  JMdict-matched), ingest join, `jmdict_lookup`/wordnet projection (proj v5),
  `services/proficiency` registry+resolver, tests, re-dumped seed. **Remaining:** (1) UI badge
  (render `getProficiency()` in `ListRow`/results/reader/flashcard), (2) level-based new-words quiz
  (needs a "select unseen words at band X" source retrieval + reuse `useTextQuiz`; see
  `docs/Design_Quiz.md`), (3) deploy (re-ingest or seed-load on prod/staging — bands NULL until
  then), (4) `data/proficiency/en.tsv` for CEFR (registry maps EN→CEFR; no wordlist yet).
- **English-as-a-learning-target — dictionary QUALITY epic** `[#11 / secondary market]` —
  English already works (selectable; EN→JA via reverse-JMdict, uk-correct: `this→これ/この`). Thin
  part is QUALITY = RANKING/content, NOT storage (fits Free; Pro only forced by English
  embeddings). Cheap-first:
  1. **English frequency** (wordfreq EN → `data/frequency/en.tsv`, ~3 MB) so an EN word's DIFFICULTY
     uses EN freq, not the matched JA entry's (`english_frequency` applied at projection).
  2. **English lemmatizer** (`ran/running → run`) — kuromoji is JA-only; EN uses Intl.Segmenter with
     no lemma. *(EN→JA LOOKUP now lemmatizes via the edge `lemmaCandidates`; the reader-side EN lemma
     is still absent.)*
  3. **English embeddings / word-map** (#11) — the storage hog (~80 MB+) + the real Free→Pro trigger;
     until then "Explore related words" is hidden for non-JA learning langs.
- **Account-linking edge cases (email ↔ Google)** `[#13]` — partially handled. (1) Sign-up
  "Continue with Google" uses `linkIdentity` (needs `security_manual_linking_enabled=true`, was
  OFF → errored; enabling preserves guest→Google vocab). (2) email/password + later Google (same
  email) auto-links ONLY if email CONFIRMED — unconfirmed can fork into two with split vocab. (3)
  Google-first then email/password signup → `updateUser` "email already registered", no UI to set
  a password. (4) Guest → sign-in-page Google switches uid (sign-in ≠ upgrade) → guest words don't
  carry, surprising. TODO: collision messaging ("this email signs in with Google — use that"), a
  claim/merge story, a guest-carry decision for sign-in Google. Verify auto-link live.
- **Source-language mismatch robustness** `[translate UX]` — a CONCRETE source that mismatches the
  text's script (source = JA but input is Latin) produces garbage (MT echoes, reader shows
  un-looked-up words). "Detect language" works; only manual mismatch bites. Fix: in
  `resolveSourceLanguage`/`useTranslate.submit`, if `detectLanguage` strongly disagrees on SCRIPT
  (kana/kanji vs Latin), override to detected (or warn). Low-risk (only on a definite mismatch).
- **Dedicated app email + sending domain** `[launch polish]` — both the Google OAuth support
  address and the Brevo SMTP sender are the founder's personal gmail. Create a dedicated mailbox
  (`noreply@<domain>` once a domain exists) + point both at it. Tied to the domain item: a domain →
  `noreply@dino.app` with SPF/DKIM, which also fixes deliverability (single-sender Brevo mail can
  spam). The domain solves branding + deliverability + app URL + the Google `supabase.co` text
  together.
- **Custom domain + branded auth** `[launch polish]` — prod is `dino-86y.pages.dev` (Cloudflare
  appends a random suffix; clean `dino.pages.dev` unobtainable); Google consent shows "Sign in to
  <ref>.supabase.co". Both cosmetic. Fix at launch: (1) register a domain (~$10/yr) → Cloudflare
  Pages (free) for a clean URL — also update Supabase Site URL/redirects + edge `ALLOWED_ORIGINS` +
  Google origins; (2) Google branding needs a Supabase **custom auth domain** (`auth.<domain>`) →
  **Pro** ($25/mo). Interim: consent App name = DINO (free).
- **Complete account deletion** `[#13]` — `delete_account()` erases public-schema data but NOT the
  `auth.users` row; pair with the auth admin API when real auth lands, else deleted users can still
  sign in.
- **Real furigana (#16)** — *very low.* Ruby above kanji + peel-matching-kana alignment
  (`alignFurigana`); group ruby correct meanwhile.
- **FSRS (#19)** — *very low.* Upgrade SRS to D/S/R (power-law, fit to `review_log`); new
  `record_review()` body, same API. HLR fine for now.

---

**To publish (non-code):** Privacy/ToS counsel review (Open follow-ups) + the Tier 1
external-console hardening. Admin tooling + Tiers 3–4 are post-launch.

## 🧪 Pre-publish QA gate
**Re-run the multi-agent pre-publish review before any published build / after any major change.**
