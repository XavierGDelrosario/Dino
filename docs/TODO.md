# DINO — TODO (Launch + Roadmap)

Remaining work only. Tags: `[concern]` raised directly · `[#N]` roadmap item ·
`[§N]` `Production_Hardening.md`.

## 🔒 Tier 1 — Hosted-only (external-console actions on the LIVE prod project)
The console-hardening items 2–4 are handled. Remaining below — none blocking launch (item
numbers preserved; cross-referenced elsewhere):
5. **Forward-only migrations** — never edit an applied migration (process, not a task). Clean-reset reproduction proven.
6. **Automated backups + PITR** — needs **Pro** (Free has none): flip the toggle + schedule `db:backup` off the DB host. 
7. **Observability — alerting**  — point the edge's structured logs (health/request/`mt_spend`, all emitting) at hosted alerting (spend, 5xx, uptime). In-code side done.

## 🛠 Admin tooling (gated admin surface; operational)
8. **Admin webpage** — role-gated ops surface (server-enforced `is_admin`, never client-only; logging tables service-role-write / admin-read):
    - **Edit `words` cache** — drive the deferred re-projection sweep (#3 / `projection_version`): flag rows < `CURRENT_PROJECTION_VERSION`, re-project/merge (destructive sweep gated on a test harness, per CLAUDE.md). **Downgraded 2026-07-13:** the read-side gate now makes stale rows a cache MISS, so they re-project themselves in place on next use — correctness no longer depends on this sweep. What's left is a STORAGE chore (rows the current projection no longer emits are never served but still occupy the 500 MB free tier) plus optional eager warming instead of lazy healing.
    - **Third-party API health** — per service, credential EXPIRY + USAGE vs quota, so nothing silently lapses/caps: **Brevo** (send count, SMTP key), **Google Cloud** (Translation key spend/quota, OAuth secret expiry), 
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

### Security & architecture hardening (2026-06-28 audit)
- **[MED] CAPTCHA for anon + email signup — CODE DONE 2026-07-13, ENABLING IT IS BLOCKED.**
  Client half shipped: `src/services/captcha.ts` (Cloudflare Turnstile, **INVISIBLE** widget —
  the anon token is minted during bootstrap, where an interactive challenge would deadlock
  first paint) feeding `signInAnonymously` / `signInWithPassword` / `resetPasswordForEmail`,
  the three endpoints GoTrue gates. (`updateUser` — the guest→account upgrade — is NOT
  captcha-gated by GoTrue, and doesn't need to be: its session already passed the anon check.)
  **Inert until `VITE_TURNSTILE_SITE_KEY` is set**, so nothing changes today. Verified in a
  real browser against the live Cloudflare script (dummy invisible keys: `1x…BB` mints a token,
  `2x…BB` rejects, widget cleaned up both times) + unit-tested; local config recipe in
  `supabase/config.toml [auth.captcha]`.
  **REMAINING (2 steps, ORDER MATTERS — the server starts REQUIRING a token the moment it's on):**
  (1) deploy a client carrying a real sitekey, THEN (2) enable Attack Protection in the
  dashboard with the matching secret. **BLOCKER — native:** Turnstile cannot run under
  `capacitor://`, so an iOS build pointed at a captcha-enabled project loses anonymous sign-in,
  and `build-ios.sh` defaults to **PROD**. Founder call (2026-07-13): **account merging lands
  before iOS is re-pointed**, so do not flip prod on until that's settled (options then: move
  dev devices to staging, switch the WebView to an `https://` scheme + a registered hostname,
  or swap to hCaptcha, which has native SDKs). Cost of waiting is low — the IP rate-limit still
  applies and paid MT stays capped; the guest sweep below reclaims the bloat meanwhile.
- **[MED] Sweep empty guests — DONE 2026-07-13** (migration `20260727`). The other half of the
  anti-sybil item, and the one that works TODAY (it needs no console flip, so it reclaims bloat
  while the captcha waits on native). `prune_anonymous_guests(min_age, max_rows, dry_run)` deletes
  ANONYMOUS users only, and only when EMPTY (no `user_words` / `lists` / `feature_grants` /
  `user_limits`), OLD (created + last-seen > 30d), and with NO current-month MT spend (so a sweep
  can never hand back a spent monthly quota). Bounded (≤500/run), audited (`account_deletion_log`),
  `dry_run` counts without deleting, EXECUTE revoked from clients, and it sets the `20260714`
  deletion-guard override itself. Weekly pg_cron (`prune-anonymous-guests`, Sun 04:23), non-fatal
  where pg_cron is absent. Verified live on local Postgres — `tests/integration/prune-guests.integration.test.ts`
  (9/9): really deletes an aged empty guest (login + profile + audit row) and KEEPS a guest with a
  word, with a list, a recent guest, one with in-month spend, and a real account; not callable by a client.
  **Remaining:** confirm the cron job is registered on prod/staging (same caveat as the
  `idempotency_keys` prune below — it no-ops without pg_cron), and consider a `dry_run` pass there
  first. This also subsumes the Tier-3 "purge dev/test guests" chore.
- **[MED · scale-only] Global-quota advisory lock** — reserved once per batch; the
  once-per-request contention only bites at huge MT throughput → shard by hash bucket /
  lock-free UPDATE if it does.
- **[LOW] `public.users.email` client-writable + unverified** — enables squatting; it's
  the lookup key in `admin_grant_feature`. Fix = BEFORE INSERT/UPDATE trigger requiring
  `email` = verified `auth.users.email` OR `<uid>@guest.dino`. DEFERRED: on the
  session-create write path → needs an integration pass (squat rejected; guest + upgrade
  still pass) before prod.
- **[LOW] Confirm `idempotency_keys` prune cron** registered on prod (`20260712` no-ops
  without pg_cron).

**Native runtime + live backend is UNtested (2026-06-28).** A CapacitorHttp regression
HUNG `supabase.functions.invoke` on iOS (stuck on "Translating…"); no test caught it — the
bug lives between three layers each tested with the others stubbed: `client.test.ts` MOCKS
`invoke`; `translate-edge.integration.test.ts` hits the edge via raw `fetch` (Kong rewrites
CORS to `*`); `e2e-smoke.mjs` MOCKS Supabase in desktop Chromium. So `invoke` never runs
for real, nothing runs in the WebView, prod CORS is only real in prod. Every native bug this
session lived here. Fixes, cheapest-first:
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
  default-reading/word override (こと→事 already wins via uk).

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
   Extend by hand only.
- 


**Remaining dictionary/reading work:**
- **EN long-tail irregulars** — ingest Princeton `verb.exc`/`noun.exc` (the bundled
  `lemmaCandidates` map is common forms only); optionally push EN lemmatization into SQL
  (`wordnet_en_ja_lookup`) so the raw function lemmatizes too, then un-skip the SQL-level spec. the rare
  specialist-counter tail;

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
 
 cost money pre-revenue. Delivery-scope only, NOT architectural (`analyze()` + services stay platform-neutral → Android is additive later).

- **Handwriting ("draw the character")**  — stroke recognition so a learner can
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
  - ** BILLING — stand up monetization IN PARALLEL.** Every Tier 4 item (LLM, Cloud
    OCR/Speech) is per-use paid → this is where Free stops being free. Build the paid plan /
    quota / Stripe ALONGSIDE: the `user_limits` + reserve-before-call seam exists; billing is
    the missing half. Decide free-vs-paid limits before launch.

- **Media ingestion — subtitles/scripts → new words** — fetch media text, run
  the EXISTING reader/quiz (the LLM is NOT the scraper — this is a fetch pipeline feeding #9).
  Per-source **adapter** → plain text → reader unchanged. Core FREE (kuromoji+JMdict); LLM/STT
  optional.
  - ** "Pre-study a series before you watch" — flagship.** Whole episode/season subs →
    content words → dedup vs known vocab → **rank by frequency** → flashcard the NEW ones (common
    first = best ROI). A full episode is the BEST domain signal (vs a noisy short paste)
  - **The real constraint is JP subtitle SUPPLY.** OpenSubtitles is EN-dominated; for JP,
    anime is well-covered (Kitsunekko) but live-action is scarce (you often find ENGLISH subs for
    a JP show — useless). Source integration is the real enabler; manual `.srt` reaches only
  - **Sources (2026-06-25):** **Kitsunekko** primary (anime JP); **OpenSubtitles API** MAYBE
    (pending legality research — key + attribution); **`.srt` upload** = safe floor, ship
    regardless. **YouTube** captions/transcript API = the clean URL win (FREE), do first with
    `.srt`. **Netflix** — no API; only defensible path is the Language-Reactor pattern (a browser
    extension reading the timed-text track of the user's own session, client-side) →
    much-later/maybe. **TikTok/IG** — no sub endpoint → download audio → STT; fragile, costs, gray.
  - **⚖️ Legal:** **derive word lists; NEVER store/redistribute the full script**  Extract vocab+glosses, discard the text — transformative, and keeps storage tiny.

## ➕ Open follow-ups (slot into tiers as you go)
- **Quality-limitations audit — see `docs/QualityLimitations.md`** `[quality · 2026-07-09]` — an
  honest map of where CONTENT/DATA quality is capped by the free Supabase tier (500 MB storage),
  the free/open source data, and free tiers of paid services. Not correctness bugs — quality
  ceilings. **Top 3 levers:** (1) **bigger embedding model + full-dict embeddings** — fixes the
  katakana-loanword clustering bug AND extends the word-map (#11/#12) past the ~45k "fat common"
  trim → **unlock: Supabase Pro** (full dict ~243 MB + 1024-dim embeds ~415 MB blow the 500 MB free
  cap). (2) **Per-SENSE granularity** for proficiency/frequency/embeddings — today all three are
  per-SURFACE, so a homograph (辛い→からい/つらい) gets one band/freq/vector for all meanings; the
  biggest *content-model* ceiling, **unlock: engineering** not money. (3) **English CEFR data + EN
  frequency** — the JA-native-learning-English market is nearly unleveled (no `en.tsv`; EN difficulty
  borrows the matched JA entry's freq), **unlock: CEFR research + a licensable list** (CEFR-J likely
  free; EVP/Oxford paid). Other noted ceilings: JLPT ±1 approximate + single-source (no free
  consensus possible), wordfreq measures COMMONNESS-not-LEVEL + can't rank multi-kanji compounds
  (唐揚げ) + the kana-freq coalesce in `jmdict_entry_headword`, JMdict terse glosses / obscure sense
  ordering / no example sentences, MT single-sense reading-less, no LLM features. Solid on free: full
  JMdict + WordNet + wordfreq + the translation/RLS core.
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
  — **BUILT (needs live verify):** a **Learn** tab (`views/LearnView.tsx`) + `learn_words_at_band`
  source retrieval (migration `20260717`) + a `{ learn }` edge mode reusing `resolveBatch` +
  `services/learn.ts`, quizzing N unseen words at a chosen band via `useTextQuiz`; still needs a live
  run (Supabase CLI/Deno unavailable in the build env) — see `docs/Proficiency.md`, (3) deploy
  (re-ingest or seed-load on prod/staging — bands NULL until then; the `20260717` migration applies
  there too), (4) `data/proficiency/en.tsv` for CEFR — **DONE + LIVE 2026-07-09.** 8,845 CEFR
  surfaces (A1→1…C2→6) from CEFR-J + Octanove (`build-proficiency-cefr.py`, olp-en-cefrj) →
  server-only `english_proficiency` table (migration `20260722`, `npm run ingest:english-proficiency`)
  → edge `applyEnglishProficiency` overrides each EN→JA row's `proficiency_band` with the ENGLISH
  input's CEFR band (never the JA JLPT one). Deployed + verified prod+staging (beautiful/wonderful→A1,
  nevertheless→B1, reluctantly→C1, flabbergasted→none→frequency). With English frequency (item 1),
  **English leveling is now complete** except EN embeddings. CEFR-J/Octanove attributed in ATTRIBUTION.md.
  **NOW DEPLOYED (2026-07-09):** proficiency + learn/calibration are LIVE on prod (`sslz…`) AND
  staging (`jfcb…`) — migrations `20260716`–`20260719` pushed, edge redeployed, `proficiency_band`
  populated by a non-destructive per-surface UPDATE from `data/proficiency/ja.tsv` (7,776 kanji +
  1,733 kana). `learn_words_at_band` v2 (migration `20260719`) added a frequency gate + frequent-pool
  random sampling (fixes rare single-kanji + no-variety-on-retry, using the writing's OWN frequency to
  avoid a rare kanji borrowing its kana's freq). Calibration now `excludeSeen=true` (no repeats on
  retake) + batch-saves known words at confidence 5.
- **Word-leveling ACCURACY: go frequency-first, JLPT only as an approximate label** `[#8 / accuracy]` —
  RESEARCHED 2026-07-09 (the level quiz surfaced the concern). Facts: (1) There is **NO official JLPT
  vocabulary/kanji list for the current test (N5–N1, 2010+)** — the Japan Foundation/JEES deliberately
  stopped publishing one (jlpt.jp/e/faq). The old pre-2010 出題基準 (levels 4–1) had official lists but
  was discontinued in 2010. (2) **Every credible JLPT dataset traces back to ONE source — Jonathan
  Waller / tanos.co.uk** (ours included, via `jamsinclair/open-anki-jlpt-decks`), so a merged/consensus
  list adds NO independent signal — don't chase it. Waller is CC BY (commercial-OK w/ attribution);
  prep-book lists (新完全マスター / 総まとめ / TRY!) are copyrighted, not redistributable. (3) **Frequency
  (wordfreq Zipf) is the objective, reproducible difficulty signal**; JLPT is an approximate label that
  disagrees with real frequency (e.g. 的 tagged N3 but ~12th most frequent kanji) and across sources —
  the jpdb/Bunpro consensus. **REVISED DECISION (2026-07-09, after founder pushback "common ≠ N5"):
  NOT frequency-primary — CURATED LEVEL LEADS.** Frequency measures COMMONNESS, which is NOT learner
  LEVEL (的 is ~12th-most-frequent kanji yet N3; 影響/経済/政治 are frequent but N3–N2, not beginner). So
  a curated JLPT/CEFR level — approximate but the RIGHT AXIS — wins where it exists; frequency is the
  dense COMMONNESS proxy only for the ~96% of words with no band, plus ordering WITHIN a level.
  **IMPLEMENTED (`getDifficulty` = `override ?? proficiency ?? frequency`, `services/difficulty`,
  2026-07-09):** the resolver now normalizes a word's `proficiency_band` (JLPT 5 bands → identity, CEFR
  6 → compressed onto 1..5) and prefers it over the Zipf bin; `fromProficiencyBand` in `level.ts`,
  wired in `registry.ts`; unit-tested (`tests/services/difficulty/difficulty.test.ts`). `learn_words_at_band`
  already selects by band + orders by frequency, so it matches this model. **REMAINING — downstream axis
  reconciliation (design call):** now that WORD difficulty is proficiency-preferred, decide the axis for
  the USER level + its consumers — (a) calibration's `users.level` is estimated via `getDifficulty` of
  tested (banded) words, so it now drifts proficiency-ward and ≈ `users.proficiency_band` (redundant);
  (b) the #12 domain filter + `seedStability` compare word-difficulty vs user-level and want a DENSE
  frequency axis for arbitrary (bandless) neighbours. Options: keep `users.level` explicitly frequency
  (feed calibration samples from frequency only) OR make everything proficiency-preferred + let bandless
  words fall to frequency. Low-urgency (±1 window absorbs it; #12 experimental) but pick one before
  #12 ships. Also: don't over-promise JLPT precision in UI copy; CEFR/EN research still pending.
  **Own-frequency fix DONE (migration `20260720`, 2026-07-09):** `jmdict_entry_headword` +
  `jmdict_lookup` now use the SHOWN writing's OWN frequency/band, not `COALESCE(kanji, kana)` — a
  rare kanji (亡い) no longer borrows its common kana's Zipf (ない's 704); verified live prod+staging
  (行く:552 stays first, 亡い→NULL). **Frequency-source research DONE (2026-07-09) — see
  `docs/research/Frequency_Sources.md`.** Verdict: **supplement wordfreq, don't replace.**
  (a) **English: add SUBTLEX-US** (best learner fit + CC-BY-SA w/ explicit commercial grant) → the
  missing `data/frequency/en.tsv`; wordfreq EN is the zero-friction fallback. Higher-value, lower-effort
  next step. (b) **BCCWJ is BLOCKED** — it has the readings (からい/つらい split) + a free list, but its
  license is research/education-ONLY (no commercial grant); do NOT ship BCCWJ-derived numbers. (c) The
  **only licensing-clean per-reading path = build our own**: MeCab (BSD) + UniDic (BSD arm) over a JA
  Wikipedia dump (CC-BY-SA), count on `(語彙素, 語彙素読み)`, join by surface AND reading — derived TSV
  stays CC-BY-SA like today; hours-scale ETL. Incremental (the surface baseline is now correct post-
  `20260720`), not urgent. (d) Optional spoken-register axis: TUBELEX (BSD-3) for the study-the-media
  thread. Avoid: BCCWJ lists, NTT, jpdb/anime scrapes, COCA, Google syntactic ngrams.
  Sources: jlpt.jp/e/faq · tanos.co.uk/jlpt/sharing · github.com/rspeer/wordfreq · clrd.ninjal.ac.jp/bccwj.
- **English-as-a-learning-target — dictionary QUALITY epic** `[#11 / secondary market]` —
  English already works (selectable; EN→JA via reverse-JMdict, uk-correct: `this→これ/この`). Thin
  part is QUALITY = RANKING/content, NOT storage (fits Free; Pro only forced by English
  embeddings). Cheap-first:

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
- **Custom domain + branded auth** `[launch polish]` — (1) register a domain (~$10/yr) → Cloudflare
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
