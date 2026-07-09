# DINO — TODO (Launch + Roadmap)

Remaining work only. Tags: `[concern]` raised directly · `[#N]` roadmap item ·
`[§N]` `Production_Hardening.md`. Shipped work lives in git history, `tests/`, and
`docs/` — not here.

## 🔒 Tier 1 — Hosted-only (external-console actions on the LIVE prod project)
Console-hardening items 2–4 done. Remaining (none blocking launch; numbers preserved):
5. **Forward-only migrations** `[concern · §11]` — never edit an applied migration (prod holds data you can't `db reset`). Process, not a task; clean-reset reproduction proven.
6. **Automated backups + PITR** `[concern · §2]` — needs **Pro** (Free has none): flip the toggle + schedule `db:backup` off the DB host. Backup + tested-restore tooling done. *(Free interim: `db:backup` manually/cron.)*
7. **Observability — alerting** `[§9]` — point the edge's structured logs (health/request/`mt_spend`, all emitting) at hosted alerting (spend, 5xx, uptime). In-code side done.

## 🛠 Admin tooling (gated admin surface; operational)
8. **Admin webpage** — role-gated ops surface (server-enforced `is_admin`, never client-only; logging tables service-role-write / admin-read):
    - **Edit `words` cache** — drive the deferred re-projection sweep (#3 / `projection_version`): flag rows < `CURRENT_PROJECTION_VERSION`, re-project/merge (destructive sweep gated on a test harness, per CLAUDE.md).
    - **Usage dashboards** — total + per-user MT from `translation_usage`/`global_translation_usage`, anonymized (bucket by user-id hash, no PII).
    - **DB usage by table** — `pg_total_relation_size` (storage headroom vs tier cap).
    - **Third-party API health** — per service, credential EXPIRY + USAGE vs quota, so nothing silently lapses/caps: **Brevo** (send count, SMTP key), **Google Cloud** (Translation key spend/quota, OAuth secret expiry), **Supabase** (access token, billing caps), future (Cloud Vision/Speech, Anthropic). Show "expires in N days" + "X/limit" with warning thresholds.
    - **Grant feature privileges (with expiry) — GRANT-ONLY, never revoke.** Grant a `user_limits`-style entitlement (raise quota, unlock voice/camera/LLM) + a duration. **Hard legal rule: a granted privilege can be EXTENDED but NEVER removed** (once paid, you can't take it away). Model as append-only grant rows (lapse by expiry, not deletion). Server-enforced; active entitlement = union of non-expired grants.
    - **Error log** (append-only, filterable) — per error: timestamp, code, MESSAGE, the INPUT, user id, surface/endpoint.
    - **Translation/MT call log** — per request: input length, resolved path (JMdict·WordNet·MT), cache hit/miss, est. cost, latency, anonymized user. Persist the edge's `mt_spend`/request stream so spend + provider mix are QUERYABLE.
    - **Quota/limit-hit events** — log every 413 (over `paragraphCharLimit`) and 429 (`monthlyCharQuota` / `GLOBAL_MONTHLY_CHAR_QUOTA` / `MT_DISABLED`), with which cap + user.
    - **Auth/account audit** — append-only sign-up / upgrade / sign-in/out / reset / deletion (who+when, never passwords).
    - **Admin-action audit** — every privileged action (grant, re-project, prune) with acting admin, target, action, time. The surface must audit ITSELF (critical given never-revoke).
    - **Content-safety blocks** — log `isExplicitSuggestion` filters (input + where) to monitor false pos/neg + abuse.
    - **Edge health/latency** — surface emitted health/request logs (p50/p95, status mix, 5xx) — in-app half of Tier 1 #7.
    - **Log retention + PRIVACY** — raw-input logs are PII: retention window (prune like `idempotency_keys`), admin-only read (RLS), bucketed user ids in aggregates.

## 🐞 Remaining bugs, scalability & hardening

### Scalability
- **EN→JA reverse-gloss heavy query** — regex-over-trigram scan + ~5 correlated
  subqueries/candidate; cache-absorbed but CPU-heavy on full prod JMdict. Materialize a
  flat `gloss_terms(term, entry_id, rank)` (btree on `term`) + denormalize
  headword/reading/freq. (`20260618_jmdict.sql`.)

### Test coverage
- **Edge error-log — end-to-end trigger still open.** The `error_log` sink contract is
  covered (`error-log.integration.test.ts`, gated). NOT covered: driving an ACTUAL failing
  edge path (translate_batch_failed / words_upsert_failed / handler_crashed) to observe the
  row land — not deterministically forceable over HTTP; fold into the native `functions.invoke`
  integration item if a forcing seam is added.
- **Native simulator smoke** (XCUITest/Appium) — the only layer exercising CapacitorHttp +
  `functions.invoke` + real CORS together (the CapacitorHttp regression that HUNG `invoke` on
  iOS had no test; the three layers are each tested with the others stubbed). Preflight smoke
  (`smoke:prod`) + the real-`invoke` integration test (`translate-invoke.integration.test.ts`)
  cover everything BUT the WebView/CapacitorHttp layer. Until justified, keep a manual device checklist.

### Security & architecture hardening (2026-06-28 audit)
- **[ops] Rotate the Google Translation key** in `supabase/functions/.env`. BOUNDED (API-restricted + `GLOBAL_MONTHLY_CHAR_QUOTA`-capped) → hygiene; keep it only in `supabase secrets`/local dev.
- **[MED] CAPTCHA for anon + email signup** — IP rate-limit is on, but a rotating-IP sybil can still bloat `auth.users` (paid MT stays capped). Add Turnstile/hCaptcha + a periodic sweep of empty guests (0 `user_words`).
- **[MED · scale-only] Global-quota advisory lock** — reserved once per batch; once-per-request contention only bites at huge MT throughput → shard by hash bucket / lock-free UPDATE if it does.
- **[LOW] `public.users.email` client-writable + unverified** — enables squatting; it's the lookup key in `admin_grant_feature`. Fix = BEFORE INSERT/UPDATE trigger requiring `email` = verified `auth.users.email` OR `<uid>@guest.dino`. Needs an integration pass before prod.
- **[LOW] UI may render raw DB messages** — render copy from the error `kind`; keep `.message` for telemetry only.
- **[LOW] CORS defaults to `*`** when `ALLOWED_ORIGINS` unset — prod sets it; default-to-deny hygiene (`_lib.ts` + `delete-account`).
- **[LOW] Confirm `idempotency_keys` prune cron** registered on prod (`20260712` no-ops without pg_cron).
- **[LOW] Memoize recognizer availability** — handwriting/speech re-hit the native bridge each check; cache per session like `analyze.ts`.

### Dictionary ranking / reading (open cases)
Wrong primaries on JA→EN single-word lookups vs full local JMdict. The reading override
(`services/language/readingOverrides.ts`, hand-verified cap) + compound-merge pass
(`services/language/compounds.ts`) + secondary-writing headwording (`20260715`) + own-frequency
headword pick (`20260720`) all shipped and are test-covered. Remaining:
- **Per-SURFACE frequency can't prefer the learner-default reading — DATA LIMITATION.** 前→ぜん
  (want まえ), もの→者 (want 物): a reading is polluted by the kanji's OTHER reading. Needs
  per-(kanji,reading) frequency (wordfreq lacks it; build-our-own path in the frequency-source
  research below) OR extending the curated override by hand. Blanket curated list was RULED OUT
  (research: ~4,169 ambiguous frequent words, many context-dependent with no single default).
- **General no-context ambiguity** — genuinely ambiguous single-kanji lookups have no clean
  default; the right long-term UX is a **multi-reading display** (top 2–3), not one guessed
  default. The context-aware reader (kuromoji) already handles words in a sentence.
- **次→つぎ override guard** — guard the reader's single-reading override against orphaned
  single-kanji fragments left by an over-segmentation split.
- **EN long-tail irregulars** — ingest Princeton `verb.exc`/`noun.exc` (bundled `lemmaCandidates`
  is common forms only); optionally push EN lemmatization into SQL (`wordnet_en_ja_lookup`), then
  un-skip the SQL-level spec.
- **Counter polish** — inline furigana ruby (data ready); rare specialist-counter tail;
  context-variant number readings (4=よん/し/よ).
- **Troublemaker reference (2026-06-28, full JMdict):** ところ→野老 vs 所; はし→階 vs 橋/箸/端;
  かみ→上 vs 紙/神/髪; 形→なり(かたち); 市→いち(し); 主→おも; 重→主[おも]; 角→かく(かど);
  もの→者(物); かえる→変える(帰る). Borderline-OK: 後→あと, 方→かた, 生→なま, あつい→熱い, 月→つき.

## 🟢 Tier 3 — Post-launch (features / polish)
- **Purge dev/test guests before the first real DB** — trivial one-time `DELETE` (current anon rows are throwaway). Run any time before publishing.
- **EN→JA reader sense quality** — WordNet synset layer leads (gloss = fallback); polish: live-verify synset grouping + tune fallback merge size.
- **Embeddings (#11) follow-ups:**
  - entry-level vectors blend homographs + leak gloss-string artifacts — consider per-sense / writing-weighted embedding.
  - **e5-large upgrade** — katakana loanwords cluster by SPELLING not meaning (ストライカー→streaker/stripper). Fix = stronger model (e5-large 1024-dim / LaBSE); needs the `vector(384)` column migrated + full re-embed (~2GB model).
  - **re-embed under the frequency-floor policy** — live vectors are the old `--common-only` 22.6k; the default (`EMBED_FREQ_FLOOR`, common ∪ freq≥250 ≈ 41k) applies only after re-embed + `npm run db:dump-seed`.
  - **English as a learning target** — word map is JA-only. Key is already multi-lang (`(source_lang, dictionary_ref)`) + `build-embeddings.py --source-lang`; a non-JA language still needs its own dictionary source + `<source>_lookup()` + per-source `related_words`.
  - prod-DB regen at deploy + HNSW tuning under load; per-language KO/ZH.

## 🚀 Tier 4 — Post-launch new features (input modalities + AI agents)
After launch, not blockers. Throughline: **free on-device on native (#18), paid/heavy on web**.
Native detail in CLAUDE.md `#18`.
> **⚠️ Scope (temporary, financial): ship the input modalities (speech, camera/OCR,
> handwriting) iOS-ONLY first.** Delivery-scope only, NOT architectural (`analyze()` + services
> stay platform-neutral → Android is additive later).
**Build order (2026-06-27): handwriting → speech-to-text → camera/OCR → AI agents → media
ingestion.** (Product priority; all three input modalities are free on-device native.)

- **Handwriting ("draw the character")** `[iOS first]` — stroke recognition so a learner can look
  up a kanji they can see but can't type; output = plain text → existing `analyze()`→JMdict
  pipeline. **Native:** Google **ML Kit Digital Ink** (on-device, FREE, JA; ~20 MB per-lang model,
  wifi-once like kuromoji's `/dict/`). **Web:** no free Google ink API — either unofficial
  `inputtools.google.com` (ToS-gray) or rasterize canvas → **Cloud Vision** OCR (reuses camera/OCR
  seam + quota). Stroke capture is trivial; recognition is the problem.
- **Speech-to-text** — cheapest win. **Web:** Web Speech API (`ja-JP`, free, Chrome-only).
  **Native:** free + on-device + offline, iOS (`Speech`/`SpeechAnalyzer`) + Android
  (`SpeechRecognizer`, API 33+). On-device isn't billed by duration → VAD/silence-trim only
  matters for the paid Cloud Speech fallback.
- **Camera / OCR (photo → text)** — **Web:** Google **Cloud Vision** TEXT/DOCUMENT_TEXT_DETECTION
  ($1.50/1k, first 1k/mo free); per-image cost → gate with button-capture + a per-user monthly
  image quota (new `user_limits` column, edge-enforced). Tesseract.js = rough free fallback.
  **Native:** FREE on-device — **ML Kit Text Recognition v2** (iOS+Android) + iOS Vision/Live Text.
  - **Mode A (photo → reader) is live on iOS** (Apple Vision `TextOcrPlugin.swift`; per-line boxes captured for Mode B; needs device verify). Follow-ups:
    - **Vertical (縦書き) — phase 2.** Mode A's row-bucket sort is HORIZONTAL only; detect by block geometry (tall/stacked lines) → columns x DESC, within-column y ASC (`readingOrder.ts`).
    - **Mode B — image overlay (AR).** Overlay translations on each box. T1: tappable chips at each box (scale img→display, EXIF); T2: "replace in place". New view on `captureResult()`'s `OcrResult`; geometry already flows.
- **AI agents — generative study aids** `[extends #12]` — needs an LLM (Claude), a NEW cost center:
  `ANTHROPIC_API_KEY` edge secret + a generations/month quota, same reserve-before-call seam.
  Discipline: hard `max_tokens` cap + cache outputs (like `words`) + prompt-cache the system prompt.
  - **Create sample sentence** using a saved word.
  - **Generate a domain paragraph quiz** — "write a short paragraph at level X using these seed words." **Fork:** an LLM can COLLAPSE the embeddings work (#11/#12) into one call — less infra, at ongoing per-use cost + less determinism.
  - **Hybrid (recommended):** embeddings for free level-aware word *selection*, LLM only for fluent *generation*. ~**$0.0017 Haiku / $0.005 Sonnet** per call (~700 in/~200 out). Rates (2026-06-25): Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15 per 1M.
  - **⚠️ BILLING — stand up monetization IN PARALLEL.** Every Tier 4 item is per-use paid → where Free stops being free. The `user_limits` + reserve-before-call seam exists; billing (paid plan / quota / Stripe) is the missing half. Decide free-vs-paid limits before launch.
- **Media ingestion — subtitles/scripts → new words** `[extends #9]` — fetch media text, run the
  EXISTING reader/quiz (the LLM is NOT the scraper). Per-source **adapter** → plain text → reader
  unchanged. Core FREE (kuromoji+JMdict); LLM/STT optional.
  - **🌟 "Pre-study a series before you watch" — flagship.** Whole episode/season subs → content words → dedup vs known → **rank by frequency** → flashcard the NEW ones. A full episode is the BEST domain signal; reuses #9 + frequency + #10, no new core infra.
  - **⚠️ The real constraint is JP subtitle SUPPLY.** Anime well-covered (Kitsunekko); live-action scarce. Source integration is the real enabler.
  - **Pre-study needs no synced subs** — ANY transcript works (sync only matters for overlay-on-video). Widens supply.
  - **Sources (2026-06-25):** Kitsunekko primary (anime JP); OpenSubtitles API MAYBE (legality pending); `.srt` upload = safe floor; YouTube captions = clean FREE win (do first); Netflix only via Language-Reactor pattern (much-later); TikTok/IG → audio→STT (fragile).
  - **⚖️ Legal:** derive word lists; NEVER store/redistribute the full script (wordfreq stance). All fetching through Privacy/ToS review. **Safest POC:** `.srt` + YouTube.

## ➕ Open follow-ups (slot into tiers as you go)
- **Quality-limitations audit — see `docs/QualityLimitations.md`** `[quality]` — where CONTENT/DATA
  quality is capped by the free Supabase tier, free data, and free service tiers (ceilings, not
  bugs). **Top 3 levers:** (1) **bigger embedding model + full-dict embeddings** → unlock: Supabase
  Pro (full dict ~243 MB + 1024-dim embeds ~415 MB blow the 500 MB cap). (2) **Per-SENSE
  granularity** for proficiency/frequency/embeddings (all three are per-SURFACE today; a homograph
  gets one band/freq/vector for all meanings) → unlock: engineering. (3) English embeddings (see
  the English epic). Other ceilings noted in the doc.
- **Downstream difficulty-axis reconciliation** `[#8 / design call]` — WORD difficulty is now
  proficiency-preferred (`getDifficulty` = `override ?? proficiency ?? frequency`, test-covered).
  Decide the USER-level axis + consumers: (a) calibration's `users.level` (estimated via
  `getDifficulty` of banded words) now drifts proficiency-ward ≈ `users.proficiency_band`
  (redundant); (b) the #12 domain filter + `seedStability` want a DENSE frequency axis for arbitrary
  bandless neighbours. Options: keep `users.level` explicitly frequency, OR make everything
  proficiency-preferred + let bandless words fall to frequency. Low-urgency (±1 window absorbs it),
  but pick one before #12 ships. Don't over-promise JLPT precision in UI copy.
- **Frequency sources — supplement wordfreq** `[#8]` — see `docs/research/Frequency_Sources.md`.
  (a) **English: add SUBTLEX-US** (best learner fit + CC-BY-SA commercial grant) → upgrades
  `data/frequency/en.tsv` (wordfreq EN is the shipped baseline). (b) **Per-reading JA path (only
  license-clean option = build our own):** MeCab (BSD) + UniDic (BSD arm) over a JA Wikipedia dump
  (CC-BY-SA), count on `(語彙素, 語彙素読み)`, join by surface AND reading — feeds the 前→まえ reading
  fix. Not urgent (surface baseline is correct post-`20260720`). Avoid: BCCWJ lists (research-only,
  no commercial grant), NTT, jpdb/anime scrapes, COCA. Optional spoken axis: TUBELEX (BSD-3).
- **Proficiency label axis — remaining features** `[#8 sibling]` — see `docs/Proficiency.md`. Data
  pipeline (JA JLPT + EN CEFR), ingest, projection, `services/proficiency`, learn/calibration, and
  the leveling resolver are DONE + LIVE (prod `sslz…` + staging `jfcb…`) and test-covered.
  Remaining: (1) **UI badge** — render `getProficiency()` in `ListRow` / translate result head /
  reader hovercard / flashcard face (nothing renders it yet); (2) live-verify the Learn tab flow
  end-to-end on a device.
- **English-as-a-learning-target — dictionary QUALITY epic** `[#11 / secondary market]` — English
  works (EN→JA reverse-JMdict, uk-correct). English frequency + CEFR bands are LIVE (edge overrides
  each EN→JA row with the English input's own value; test-covered via `applyInputAttributeOverride`).
  Remaining, cheap-first: (1) **SUBTLEX-US** frequency upgrade (above); (2) **English lemmatizer**
  (`ran/running → run`) for the reader side — EN→JA lookup already lemmatizes via edge
  `lemmaCandidates`, but the reader-side EN lemma is still absent; (3) **English embeddings /
  word-map** (#11) — the storage hog (~80 MB+) + the real Free→Pro trigger; "Explore related words"
  stays hidden for non-JA learning langs until then.
- **Separate staging DB for iOS dev-device builds** `[concern · dev-env]` — `ios:build` is hardcoded
  to PROD, so every on-device sign-up/save/review + any paid-MT lands in prod. A staging Supabase
  project exists (`jfcb…`, `DINO_ENV=staging`); the remaining gap is making the dev *device* build
  default to it (Simulator reaches `127.0.0.1` local, but can't exercise on-device
  speech/camera/handwriting). App-data half of Tier 1 #5.
- **Legal — Privacy/ToS counsel review** `[§10]` — `/privacy` + `/terms` DRAFTED + footer-linked.
  Remaining: **counsel review before going truly public**. Bump `CURRENT_TERMS_VERSION` in
  `src/lib/terms.ts` when reviewed copy lands.
- **Account-linking edge cases (email ↔ Google)** `[#13]` — partially handled. TODO: collision
  messaging ("this email signs in with Google — use that"), a claim/merge story, a guest-carry
  decision for sign-in Google; verify auto-link live. (Cases: `linkIdentity` needs
  `security_manual_linking_enabled`; email+later-Google auto-links only if email CONFIRMED;
  Google-first then email/password has no set-password UI; guest→sign-in-Google switches uid so
  guest words don't carry.)
- **Source-language mismatch robustness** `[translate UX]` — a CONCRETE source mismatching the text's
  script (source=JA, input Latin) produces garbage. Fix: in `resolveSourceLanguage`/`useTranslate.submit`,
  if `detectLanguage` strongly disagrees on SCRIPT, override to detected (or warn). Low-risk.
- **Dedicated app email + sending domain** `[launch polish]` — the Google OAuth support address + Brevo
  SMTP sender are both the founder's personal gmail. Create `noreply@<domain>` (once a domain exists)
  with SPF/DKIM → fixes branding + deliverability + app URL together.
- **Custom domain + branded auth** `[launch polish]` — prod is `dino-86y.pages.dev`; Google consent
  shows "<ref>.supabase.co". Fix: (1) register a domain → Cloudflare Pages (also update Supabase Site
  URL/redirects + edge `ALLOWED_ORIGINS` + Google origins); (2) Google branding needs a Supabase
  custom auth domain → **Pro**. Interim: consent App name = DINO (free).
- **Complete account deletion** `[#13]` — `delete_account()` erases public-schema data but NOT the
  `auth.users` row; pair with the auth admin API, else deleted users can still sign in.
- **Real furigana (#16)** — *very low.* Ruby above kanji + peel-matching-kana alignment
  (`alignFurigana`); group ruby correct meanwhile.
- **FSRS (#19)** — *very low.* Upgrade SRS to D/S/R (power-law, fit to `review_log`); new
  `record_review()` body, same API. HLR fine for now.

---

**To publish (non-code):** Privacy/ToS counsel review + the Tier 1 external-console hardening.
Admin tooling + Tiers 3–4 are post-launch.

## 🧪 Pre-publish QA gate
**Re-run the multi-agent pre-publish review before any published build / after any major change.**
