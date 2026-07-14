# DINO — TODO (Launch + Roadmap)

Remaining work only. Shipped work → git history, `tests/`, `docs/`.
Tags: `[concern]` raised directly · `[#N]` roadmap item · `[§N]` `Production_Hardening.md`.

---

## ⏳ Awaiting merge — code done, just merge
| PR | What | Note |
|----|------|------|
| **#30** | CORS default-to-deny · error-`kind` rendering · recognizer memoization | LOW security cluster |
| **#31** | EN→JA sense ordering | ⚠️ **Check first — likely superseded.** #29 shipped the same fix (cat→猫, water→水) and is on `main`. |

*Landed 2026-07-13 (was in this table): #24 publishable key · #32 captcha + guest sweep · #34 stale-cache read gate. #22 closed as obsolete.*

---

## 🔒 Tier 1 — Hosted-only (live prod console)
Items 2–4 done. None blocking launch. Numbers preserved.

**5. Forward-only migrations** `[§11]`
- Never edit an applied migration (prod has data; no `db reset`).
- Process, not a task.

**6. Automated backups + PITR** `[§2]`
- Needs **Pro** (Free has none): flip toggle + schedule `db:backup` off the DB host.
- Tooling: done. Interim: run `db:backup` manually/cron.

**7. Observability — alerting** `[§9]`
- Point edge structured logs at hosted alerting. Watch: spend, 5xx, uptime.
- Emitted today: `mt_spend` · `request` · `global_cap_reached`. **No `health` EVENT** — `/health` is a liveness endpoint whose responses fall through the generic `request` line.

**8. Confirm pg_cron jobs registered on prod/staging**
- Guest sweep (`20260727`, weekly) + `idempotency_keys` prune (`20260712`).
- Both silently **no-op** without pg_cron. Do a `dry_run` pass first.

---

## 🛠 Admin tooling
**Shipped:** `AdminPage.tsx`, gated by `is_admin` — panels: Usage · API health · Grants · Errors · DB size (migrations `20260704`–`20260708`).

**Remaining panels / logs:**

**Edit `words` cache** — re-projection sweep (#3) — *downgraded 2026-07-13*
- **Correctness is SOLVED** — shipped in #34, on `main`. Stale rows are a cache MISS and re-project themselves in place on next use: `FRESH_OR_MT` gate (`src/lib/projection.ts`) applied in both edge read paths + all 3 client repo call sites; `CURRENT_PROJECTION_VERSION = 7` (drift-guarded by `tests/services/projection-version.test.ts`); MT rows exempt, so healing can't re-spend Google credits. Covered by `tests/integration/stale-cache.integration.test.ts`.
- **Left — STORAGE chore, not correctness:** rows the current projection no longer emits are never served but still occupy the 500 MB free tier.
- **Left — destructive merge/repoint:** still gated on a test harness.
- Optional: eager warming instead of lazy healing.

**Translation / MT call log**
- Per request: input length · path (JMdict·WordNet·MT) · cache hit/miss · est. cost · latency · anon user.
- Persist edge's `mt_spend` stream → spend + provider mix become queryable.

**Quota / limit-hit events**
- Log every 413 (`paragraphCharLimit`) + 429 (`monthlyCharQuota` · `GLOBAL_MONTHLY_CHAR_QUOTA` · `MT_DISABLED`), with cap + user.

**Auth / account audit**
- Append-only: sign-up · upgrade · sign-in/out · reset. Who + when, never passwords.
- Deletion already covered by `account_deletion_log`.

**Admin-action audit**
- Partial today: `feature_grants.granted_by` + `provider_status.updated_by` stamp an actor.
- Missing: a real audit table (action · target · admin · time). Prune is unaudited; re-projection has no admin action to audit yet.
- The surface must audit itself (critical: grants are never-revoke).

**Content-safety blocks**
- `services/contentSafety.ts` filters but records nothing.
- Log `isExplicitSuggestion` hits (input + where) → monitor false pos/neg + abuse.

**Edge health / latency**
- Surface emitted health/request logs: p50/p95, status mix, 5xx. In-app half of Tier 1 #7.

**Log retention + privacy**
- Done: admin-only read (RLS + `is_admin`-gated `admin_error_log`). `idempotency_keys` already prunes (7d, daily cron).
- Left: **retention window for `error_log`** (stores raw input, 500-char truncated → PII) + bucketed user ids in aggregates.
- ⚠️ **Not a drop-in:** `error_log` is deliberately un-prunable — `20260706` REVOKEs DELETE/TRUNCATE even from `service_role`. Retention needs a migration that re-grants DELETE, trading against the append-only audit guarantee. Decide which wins.

**API health: auto-pull real usage**
- Already auto: Google MT chars (`admin_provider_health` reads `global_translation_usage` live).
- Still manual (`credential_expires_at` + free-form `quota_note`): **Brevo** send count (the v3 API key works — see `BREVO_API_KEY` in `.env.deploy`) · **Google** quota + OAuth secret expiry · **Supabase** billing caps.

---

## 🐞 Bugs · scalability · hardening

### Scalability — mostly handled (#28); one residual
**EN→JA reverse-gloss regex scan** — *low priority, not a launch risk*
- **Done (#28, `20260726`):** headword resolution materialized → PK join, not ~5 correlated subqueries/candidate (WordNet "run" 1009→298 ms); edge skips the gloss scan for stopwords ("the" 8.8 s→~1 s).
- **Left:** the `gl.text ~* '\yword\y'` regex-over-trigram scan itself (`20260618_jmdict.sql`); no flat `gloss_terms` table exists.
- **Measured (full 217k JMdict, local):** 83–418 ms — and only on the FALLBACK path (WordNet leads EN→JA), cache-absorbed on repeat.
- **If it ever matters:** materialize `gloss_terms(term, entry_id, rank)` (btree on `term`).

### Test coverage
**Edge error-log — e2e trigger open**
- Covered: the sink contract (`error-log.integration.test.ts`, gated).
- Not covered: driving a real failing edge path (`translate_batch_failed` / `words_upsert_failed` / `translate_handler_crashed`) to watch the row land — not deterministically forceable over HTTP.

**Native simulator smoke** (XCUITest/Appium)
- Only layer exercising CapacitorHttp + `functions.invoke` + real CORS **together**.
- The CapacitorHttp regression that HUNG `invoke` on iOS had no test — each layer is tested with the others stubbed.
- Until justified: keep a manual device checklist.

### Security (2026-06-28 audit)
**[ops] Rotate the Google Translation key**
- In `supabase/functions/.env`. Bounded (API-restricted + `GLOBAL_MONTHLY_CHAR_QUOTA`) → hygiene, not urgent.
- Keep it only in `supabase secrets` / local dev.

**[MED] Enable captcha in prod** — code is ON MAIN (`src/services/captcha.ts`), inert without `VITE_TURNSTILE_SITE_KEY`
- **Order matters** (server requires a token the moment it's on): (1) deploy client with real sitekey → (2) enable Attack Protection with matching secret.
- **Blocked — native:** Turnstile can't run under `capacitor://`; `build-ios.sh` defaults to PROD → flipping it kills anon sign-in on iOS.
- Founder call (2026-07-13): **account merging lands first.**
- Then: point dev devices at staging · OR `https://` WebView scheme + registered hostname · OR swap to hCaptcha (native SDKs).
- Cost of waiting: low — IP rate-limit still applies, paid MT capped, guest sweep reclaims bloat.

**[MED · scale-only] Global-quota advisory lock**
- Reserved once per batch; contention only bites at huge MT throughput.
- If it does: shard by hash bucket / lock-free UPDATE.

**[LOW] `public.users.email` client-writable + unverified**
- Enables squatting; it's the lookup key in `admin_grant_feature`.
- Fix: BEFORE INSERT/UPDATE trigger — `email` must = verified `auth.users.email` OR `<uid>@guest.dino`.
- On the session-create write path → needs an integration pass (squat rejected; guest + upgrade still pass).

### Dictionary ranking / reading
Shipped + test-covered: `readingOverrides.ts` · `compounds.ts` · secondary-writing headwording (`20260715`) · own-frequency headword pick (`20260720`). Remaining:

**Per-surface frequency can't pick the learner-default reading — DATA LIMITATION**
- **Scope: the SQL ranking only.** `jmdict_lookup` can't prefer the learner-default reading (a reading is polluted by the kanji's *other* reading). The curated `readingOverrides.ts` is the only lever, applied in `lookupWord` — and it already fixes the classic cases (前→まえ, もの→物, 形→かたち, ところ→所). **Do not re-file those as bugs.**
- Real fix needs per-(kanji, reading) frequency — wordfreq lacks it (see Frequency sources below).
- Blanket curated list: **ruled out** (~4,169 ambiguous frequent words; many context-dependent, no single default). Extend by hand only.
- ⚠️ Override applies in `lookupWord`, NOT `lookupWordsBatch` (reader path) — mostly moot, the reader uses kuromoji's context reading.
- 🍒 **Quick win: 市.** Only 2 senses (いち/し), tied at f=567 → entry-id tiebreak decides. One line (`市: "し"`) in `SINGLE_WORD_READING_OVERRIDES` fixes it and meets all 3 inclusion criteria.

**General no-context ambiguity**
- Single-kanji lookups have no clean default. Right long-term UX = **multi-reading display** (top 2–3), not one guess.
- In-sentence is already fine (kuromoji has context).

**次→つぎ override guard**
- Guard the reader's single-reading override against orphaned single-kanji fragments from an over-segmentation split.

**EN long-tail irregulars**
- Ingest Princeton `verb.exc` / `noun.exc` (bundled `lemmaCandidates` = common forms only).
- Optional: push EN lemmatization into SQL (`wordnet_en_ja_lookup`), then un-skip the SQL spec.

**Counter polish**
- Inline furigana ruby (data ready) · rare specialist-counter tail · context-variant numbers (4 = よん/し/よ).

**Troublemakers — re-tested live vs full JMdict 2026-07-13 (4 of the old 9 are FIXED):**
- **Still wrong:** はし→階 (want 橋/箸/端) · 市→いち (want し — see quick win above) · 主→おも (want しゅ/ぬし) · 角→かく (want かど) · かえる→変える (want 帰る too; marginal, f=463 vs 466).
- **Fixed — don't re-file:** ところ→所 · 形→かたち · もの→物 · 前→まえ (all via `readingOverrides.ts`).
- **Moved:** かみ (上/紙/神/髪) isn't a troublemaker — no single correct default → belongs under *general no-context ambiguity* above.
- **Borderline-OK (unchanged):** 後→あと · 方→かた · 生→なま · あつい→熱い · 月→つき.

---

## 🟢 Tier 3 — Post-launch polish
**EN→JA reader sense quality**
- WordNet synsets lead, gloss = fallback. Polish: live-verify synset grouping + tune fallback merge size.

**Embeddings (#11) follow-ups**
- **Per-sense vectors** — entry-level blends homographs + leaks gloss-string artifacts.
- **e5-large upgrade** — katakana loanwords cluster by *spelling* not meaning (ストライカー→streaker/stripper). Needs `vector(384)` migrated + full re-embed (~2 GB model).
- **Re-embed under the frequency floor** — live vectors are the old `--common-only` 22.6k; default (`EMBED_FREQ_FLOOR`, common ∪ freq≥250 ≈ 41k) applies only after re-embed + `db:dump-seed`.
- **English word map** — JA-only today. Key is multi-lang already; a new lang still needs its own dict source + `<source>_lookup()` + `related_words`.
- Prod-DB regen at deploy · HNSW tuning under load · KO/ZH.

---

## 🚀 Tier 4 — Post-launch features (input modalities + AI)
Throughline: **free on-device on native (#18), paid/heavy on web.** Detail in CLAUDE.md `#18`.
> ⚠️ **Scope (temporary, financial): input modalities ship iOS-ONLY first.** Delivery-scope only — `analyze()` + services stay platform-neutral, Android is additive later.

**Build order (2026-06-27):** handwriting → speech → camera/OCR → AI agents → media ingestion.

### Handwriting — "draw the character" `[iOS first]`
- **Why:** look up a kanji you can see but can't type. Output = plain text → existing `analyze()`→JMdict pipeline.
- **iOS:** ML Kit Digital Ink — on-device, FREE, JA; ~20 MB per-lang model (wifi-once, like kuromoji `/dict/`).
- **Web:** no free Google ink API → unofficial `inputtools.google.com` (ToS-gray) OR rasterize canvas → Cloud Vision OCR.
- **Note:** stroke capture is trivial; *recognition* is the problem.

### Speech-to-text
- **Web:** Web Speech API (`ja-JP`) — free, Chrome-only.
- **iOS:** `Speech` / `SpeechAnalyzer` — free, on-device, offline. **Android:** `SpeechRecognizer` (API 33+).
- **Note:** on-device isn't billed by duration → silence-trim only matters for the paid Cloud Speech fallback.

### Camera / OCR — photo → text
- **iOS:** Apple Vision — **Mode A live** (`TextOcrPlugin.swift`; per-line boxes captured). Needs device verify.
- **Web:** Cloud Vision ($1.50/1k, first 1k/mo free) → per-image cost. Gate with button-capture + a per-user monthly image quota (new `user_limits` column, edge-enforced). Tesseract.js = rough free fallback.
- **Native alt:** ML Kit Text Recognition v2 (one lib, iOS+Android).
- **Follow-up — vertical (縦書き):** row-bucket sort is HORIZONTAL only → detect by block geometry (tall/stacked), columns x DESC, within-column y ASC (`readingOrder.ts`).
- **Follow-up — Mode B, image overlay (AR):** T1 tappable chips at each box (scale img→display, EXIF) · T2 "replace in place". Geometry already flows from `captureResult()`.

### AI agents — generative study aids `[extends #12]`
- **Cost center:** `ANTHROPIC_API_KEY` edge secret + generations/month quota, same reserve-before-call seam.
- **Discipline:** hard `max_tokens` cap · cache outputs (like `words`) · prompt-cache the system prompt.
- **Features:** sample sentence from a saved word · domain paragraph quiz ("write a paragraph at level X using these seed words").
- **Fork:** an LLM can COLLAPSE #11/#12 into one call — less infra, but per-use cost + less determinism.
- **Hybrid (recommended):** embeddings for free level-aware *selection*; LLM only for fluent *generation*. ~$0.0017 Haiku / $0.005 Sonnet per call (~700 in / ~200 out).
- ⚠️ **BILLING — build monetization IN PARALLEL.** Every Tier 4 item is per-use paid → this is where Free stops being free. `user_limits` + reserve-before-call exist; the paid plan / Stripe half doesn't. Decide free-vs-paid limits **before launch**.

### Media ingestion — subtitles/scripts → new words `[extends #9]`
- **How:** per-source adapter → plain text → existing reader/quiz, unchanged. Core is FREE (kuromoji + JMdict); LLM/STT optional. The LLM is **not** the scraper.
- 🌟 **Flagship — "pre-study a series before you watch":** whole episode/season subs → content words → dedup vs known → rank by frequency → flashcard the new ones. Best domain signal there is; reuses #9 + frequency + #10.
- **Needs no synced subs** — any transcript works (sync only matters for overlay-on-video). Widens supply a lot.
- ⚠️ **Real constraint = JP subtitle SUPPLY.** Anime well-covered (Kitsunekko); live-action scarce.
- **Sources:** Kitsunekko (primary, anime JA) · `.srt` upload (safe floor) · YouTube captions (clean free win — **do first**) · OpenSubtitles (legality pending) · Netflix only via Language-Reactor pattern (much later) · TikTok/IG → audio→STT (fragile).
- ⚖️ **Legal:** derive word lists; **never store/redistribute the full script.** All fetching through Privacy/ToS review.

---

## ➕ Open follow-ups

### Custom domain + email deliverability `[launch polish · partly URGENT]`
- **Status (2026-07-13):** prod email **works but lands in spam.** Brevo delivers (reset = `DELIVERED`); sender switched to Brevo-validated `dinolanguagestudy@gmail.com`; auth rate limit raised 2→30/hr.
- **Why spam:** sender is `@gmail.com`, and `gmail.com` authorizes only Google's servers (SPF `redirect=_spf.google.com`) → SPF/DKIM can **never** align through Brevo.
- **Fix (one task, 3 payoffs):** register a domain (~$10/yr, Cloudflare Registrar — at-cost, same dashboard as Pages) → authenticate in Brevo (SPF/DKIM/DMARC; **zero authenticated domains today**) → send from `noreply@<domain>`.
- **Also fixes:** app URL (`dino-86y.pages.dev`) → update Supabase Site URL/redirects + edge `ALLOWED_ORIGINS` + Google origins.
- **Google consent branding:** needs a Supabase custom auth domain → **Pro**. Interim: consent App name = DINO (free).
- **Careful:** staging (`jfcb…`) has **no SMTP** — auth emails there go nowhere. Test reset flows on the local stack (Inbucket, `:54324`).

### Quality-limitations audit `[quality]` — see `docs/QualityLimitations.md`
Where content/data quality is capped by free tiers. Ceilings, not bugs. Top 3 levers:
- **Bigger embedding model + full-dict embeddings** → unlock: **Supabase Pro** (full dict ~243 MB + 1024-dim ~415 MB blow the 500 MB cap).
- **Per-SENSE granularity** (proficiency/frequency/embeddings are all per-SURFACE → a homograph gets one band/freq/vector) → unlock: engineering, not money.
- **English embeddings** → see the English epic.

### Downstream difficulty-axis reconciliation `[#8 · design call]`
- WORD difficulty is now proficiency-preferred (`override ?? proficiency ?? frequency`).
- **Conflict:** (a) calibration's `users.level` now drifts proficiency-ward ≈ `users.proficiency_band` (redundant); (b) #12's domain filter + `seedStability` want a **dense frequency** axis for bandless neighbours.
- **Pick one:** keep `users.level` explicitly frequency, OR go proficiency-preferred everywhere + let bandless words fall to frequency.
- Low-urgency (±1 window absorbs it) but decide **before #12 ships**. Don't over-promise JLPT precision in UI copy.

### Leveling registry + SRS ease `[#8]` — **BUILT 2026-07-14** (`20260731`), remaining below
DONE: one language-agnostic ease calculator (`srs_leveling`) + a per-language profile as
MEASURED reference data (`npm run build:leveling -- JA`), ease capped by signal quality
(band 2.5× / frequency 1.6×), POS correction in the safe direction only, and `review_log`
now records `ease`/`word_position`/`user_position`/`level_source`/`retrievability`.
Verified live: an N5 word an N3 user grades 5 goes 82d → 525d → retired, an at-level word
stays on the normal ladder (46d → 156d → 426d), and a lapse pulls either back to ~2 days.
**Remaining:**
- **Run `build:leveling` on every environment** (staging + prod) after their ingests — the
  ease is INERT without a profile, so prod is still level-blind until this runs.
- **English has no POS source** → EN gets band anchors only (no offsets), so its ease
  leans entirely on CEFR coverage. Needs an English POS tagging pass before it can use
  the frequency path properly.
- **FIT the curve from `review_log`** (slope `ease_per_unit`, the two caps, the POS
  offsets) against real recall once there's volume. Today they're calibrated against JLPT,
  which is itself only a proxy — see §6 of the research doc.
- **`user_language_levels`** — `users.proficiency_band` is still a single language-agnostic
  column, so switching learning language would silently level the new language with the
  old framework's band. Guarded (ease → 1.0 on a language mismatch), not fixed. Do it
  before a second learning language ships.

The evidence the design is built on (7,523 JLPT-banded surfaces, local DB):
- **Frequency vs JLPT: R² = 0.24**, exact match 31.5%, MAE 0.96 levels. **14.7%** of words
  are ≥2 levels *easier* by frequency than JLPT says — the direction that would wrongly
  retire a word. Coverage is the mirror image: bands cover **3.4%** of the dictionary
  (60% of looked-up words); frequency covers **21.7%** (91%). Neither can be dropped.
- **The disagreement is POS-structured** (root cause: frequency is per-SURFACE, and
  inflection splits a word's mass across its forms). Relative to the median frequency of
  its own JLPT band: **affixes/counters +0.60 Zipf** (never inflect → mass concentrates),
  **verbs −0.76** (heavily inflected → look rarer than they are), nouns/adjectives/adverbs
  ±0.06 (fine). Correcting ONLY in the safe direction (never nudge a word *easier*) roughly
  halves the risky class.
- **English is a different shape and can't reuse any of it:** far less inflection, no
  counters, CEFR is 6 bands not 5, and `words.part_of_speech` on an EN-source row holds
  **JMdict Japanese tags describing the translation** (`pension` → `{n, adj-no}`) — there is
  no English POS source at all today.
**A structurally different language** (ZH blending character-vs-word frequency; KO needing
morphological analysis before surface frequency means anything) is the one case that would
need more than a profile — a per-language RESOLVER. Deliberately NOT built: the seam stays
empty until something forces it, as in `senses/registry.ts`.
Full analysis + reproducible queries: `docs/research/Frequency_vs_Proficiency_by_POS.md`.

### Frequency sources — supplement wordfreq `[#8]` — see `docs/research/Frequency_Sources.md`
- **English:** add **SUBTLEX-US** (best learner fit; CC-BY-SA w/ commercial grant) → upgrades `data/frequency/en.tsv`.
- **Per-reading JA (only license-clean path = build our own):** MeCab (BSD) + UniDic over a JA Wikipedia dump (CC-BY-SA) → count on `(語彙素, 語彙素読み)`, join by surface AND reading. Feeds the 前→まえ fix.
- Not urgent — surface baseline is correct post-`20260720`.
- **Avoid:** BCCWJ lists (research-only) · NTT · jpdb/anime scrapes · COCA. Optional spoken axis: TUBELEX (BSD-3).

### Proficiency label axis — remaining `[#8 sibling]` — see `docs/Proficiency.md`
Pipeline, ingest, projection, resolver, learn/calibration: **DONE + LIVE** (prod + staging), test-covered. Left:
- **UI badge — half done.** `WordInfo.tsx` renders `getProficiency()`, already wired into **ListRow** + **FlashcardCard**. Remaining surfaces: **translate result head** + **reader hovercard**.
- **Live-verify the Learn tab** on a device (unit + RPC tests already pass; only the device run is unverified).

### English as a learning target `[#11 · secondary market]`
Works today (EN→JA reverse-JMdict, uk-correct). EN frequency + CEFR bands are LIVE. Left, cheap-first:
- **SUBTLEX-US** frequency upgrade (above).
- **English lemmatizer** (`ran/running → run`) for the **reader** side — EN→JA *lookup* already lemmatizes via edge `lemmaCandidates`; the reader-side lemma is absent.
- **English embeddings / word-map** (#11) — the storage hog (~80 MB+) and the real Free→Pro trigger. "Explore related words" stays hidden for non-JA learning langs until then.

### Point iOS dev builds at staging by DEFAULT `[concern · dev-env]`
- Wiring is **done**: `build-ios.sh` resolves `DINO_ENV=staging` → `.env.deploy.staging`, and `ios:build:staging` exists.
- Left: **plain `ios:build` still defaults to PROD** → an absent-minded device build puts sign-ups/saves/paid-MT in prod. Flip the default. One-liner.

### Legal — Privacy/ToS counsel review `[§10]`
- `/privacy` + `/terms` drafted + footer-linked. Remaining: **counsel review before going truly public.**
- Bump `CURRENT_TERMS_VERSION` (`src/lib/terms.ts`) when reviewed copy lands.

### Account-linking edge cases (email ↔ Google) `[#13]`
- **Gates the captcha rollout** (see Security).
- TODO: collision messaging ("this email signs in with Google — use that") · a claim/merge story · guest-carry decision for sign-in-Google · verify auto-link live.
- Cases: `linkIdentity` needs `security_manual_linking_enabled` · email + later-Google auto-links only if email CONFIRMED · Google-first then email/password has no set-password UI · guest → sign-in-Google switches uid, so guest words don't carry.

### Source-language mismatch robustness `[translate UX]`
- A concrete source mismatching the script (source=JA, Latin input) produces garbage.
- Fix: in `resolveSourceLanguage` / `useTranslate.submit`, if `detectLanguage` strongly disagrees on SCRIPT → override to detected (or warn). Low-risk.

### Very low priority
- **Real furigana (#16)** — ruby above kanji + peel-matching-kana alignment (`alignFurigana`). Group ruby is correct meanwhile.
- **FSRS (#19)** — upgrade SRS to D/S/R (power-law, fit to `review_log`). New `record_review()` body, same API. HLR fine for now.

---

**To publish (non-code):** Privacy/ToS counsel review + Tier 1 console hardening. Admin tooling + Tiers 3–4 are post-launch.

## 🧪 Pre-publish QA gate
**Re-run the multi-agent pre-publish review before any published build / after any major change.**
