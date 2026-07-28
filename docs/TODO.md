# DINO — TODO (Launch + Roadmap)

Remaining work only. Shipped → git history, `tests/`, `docs/`.
Tags: `[concern]` raised directly · `[#N]` roadmap · `[§N]` `Production_Hardening.md`.
Sections collapsible (▸). Order **topical, not priority** — priority is in each note.
Housekeeping (Production Rules · Awaiting merge · Admin) parked at the **bottom**.

---

<details open>
<summary><h2>🚀 Features to add</h2></summary>

Post-launch: media study · input modalities · AI.
- Rule: **free on-device on native (#18); paid/heavy on web.** See CLAUDE.md `#18`.
- ⚠️ Input modalities ship **iOS-only first** (financial). Delivery-scope only — `analyze()` + services stay platform-neutral; Android additive later.
- By surface: 📱 App · 🧩 Extension · shared 🌐 Websites + ⚙️ General.
- Core (`analyze()` → `services/` → account) is identical across surfaces; only intake differs.

### 📱 App — in-app surfaces (web + native)

#### Handwriting — "draw the character" `[iOS first]`
- **iOS:** ML Kit Digital Ink. On-device, free, JA. ~20 MB model, wifi-once.
- **Web:** no free Google ink API. Options: `inputtools.google.com` (ToS-gray) · canvas raster → Cloud Vision.
- Stroke capture is trivial; recognition is the hard part.

#### Speech-to-text
- **Web:** Web Speech API (`ja-JP`). Free, Chrome-only.
- **iOS:** `Speech` / `SpeechAnalyzer`. Free, on-device, offline.
- **Android:** `SpeechRecognizer` (API 33+).
- On-device isn't billed by duration → silence-trim only matters for paid Cloud Speech.

#### Camera / OCR — photo → text
- **iOS:** Apple Vision. Mode A live (`TextOcrPlugin.swift`, per-line boxes). Device verify needed.
- **Web:** Cloud Vision ($1.50/1k, 1k/mo free). Gate: button-capture + per-user monthly image quota (`user_limits` col, edge-enforced). Tesseract.js = rough free fallback.
- **Native alt:** ML Kit Text Recognition v2 (iOS+Android, one lib).
- **Vertical (縦書き):** row-bucket sort is horizontal-only. Fix: block geometry (tall/stacked), cols x DESC, within-col y ASC (`readingOrder.ts`).
- **Mode B, AR overlay:** T1 tappable chips per box (scale img→display, EXIF) · T2 replace-in-place. Geometry flows from `captureResult()`.

#### AI agents — generative study aids `[extends #12]`
- **Cost:** `ANTHROPIC_API_KEY` secret + generations/month quota. Same reserve-before-call seam.
- **Discipline:** hard `max_tokens` · cache outputs (like `words`) · prompt-cache the system prompt.
- **Features:** sample sentence from a saved word · domain paragraph quiz ("paragraph at level X from these seeds").
- **Fork:** an LLM can collapse #11/#12 into one call. Less infra; per-use cost + less determinism.
- **Hybrid (rec):** embeddings for free level-aware selection; LLM only for generation. ~$0.0017 Haiku / $0.005 Sonnet per call.
- ⚠️ **Billing — build monetization in parallel.** Every item here is per-use paid. Free stops being free. `user_limits` + reserve exist; Stripe/plan half doesn't. Set free-vs-paid limits **before launch**.

#### Article library — headlines → analysis → link-out `[extends #9 · legal-clean media]`
- **Shape:** RSS/API headlines on our side → click → server-side fetch + analyze → **derived data only** → link out.
  - Derived = difficulty stats/graphs + **deduped, reordered** word list (confidence/reading/meaning overlay) + quiz-new (#9).
- ⚖️ **Legal = info analysis, NOT republication:**
  - JP **Copyright Act Art. 30-4** (2018): reproduction for info-analysis, incl. commercial. Strongest lever (founder in Japan).
  - US analog: Google Books / HathiTrust.
  - Rule: word list **deduped + reordered** (doc order = a reproduction). **Persist derived, never prose** (like `persist:false`). Minimal snippets. Counsel-confirm.
- **Not a downgrade — it IS the pre-study feature:** stats → quiz hard words → read the real article primed.
- Keep the inline reader for **user-pasted** text (private use, no license).
- **Re-hostable sources** (store + serve OK): Wikipedia (CC BY-SA, MediaWiki API, topic-rich) · VOA (public domain, graded EN) · Wikinews (CC BY). Avoid CC **NC/ND** (commercial). Aozora (PD JA lit) for advanced.
- **Third-party news** (NHK): analysis + link-out only. Long-term: pursue a license.

#### Media tab — in-depth analysis for longer works `[extends the reader "Quick summary"]`
- **Built already:** the reader's **"Quick summary"** (`AnalyzeInfographic` + `services/analyze/summarize.ts`) — a light per-paragraph readout: Known/New coverage pie (with %s) + tabbed Confidence / Frequency / Difficulty bars + a "show knowledge" overlay. Abstract + reusable across surfaces.
- **The Media tab is the DEEP version for whole articles/episodes/seasons** — same data core, more actionable representations:
  - **Comprehension headline** — one number: known ÷ in-dictionary words → a verdict against reading thresholds (~95% comfortable · ~98% fluent · <90% hard), e.g. "91% — challenging · 14 new words to reach 95%". The highest-value single stat.
  - **"Study these first" list** — new words ranked by **frequency** (New × common = high ROI; rare-new = skip) → a **"Quiz these N → 95%"** CTA that feeds #9 / the pre-study flow.
  - **Frequency × knowledge quadrant/scatter** — the one genuinely new insight: common+unknown = study now · rare+unknown = skip · (crosses both axes; a per-axis bar can't show it).
  - Optional: **effort estimate** (N new words to hit 95%) · **level match** ("this text ≈ N3; you're ≈ N3").
- **Reuse** the abstract `AnalyzeInfographic` where a chart fits; the new pieces are mostly new *summaries* over the same per-word data, not new infra.

#### Media ingestion — subtitles/scripts → new words `[extends #9]`
- **How:** per-source adapter → plain text → existing reader/quiz. Core free (kuromoji + JMdict). LLM/STT optional, not the scraper.
- 🌟 **Flagship — pre-study a series:** episode/season subs → content words → dedup vs known → rank by freq → flashcard. Reuses #9 + freq + #10.
- No synced subs needed — any transcript works. Sync only matters for video overlay.
- ⚠️ **Real constraint = JP subtitle supply.** Anime covered (Kitsunekko); live-action scarce.
- **Sources:**
  - Kitsunekko (primary, anime JA) · `.srt` upload (safe floor).
  - **YouTube captions — not the easy win.** Official API `captions.download` = own videos only. `timedtext`/`youtube-transcript` = unofficial, ToS-gray, breaks. Clean paths: (a) browser extension (user session), (b) CC-BY videos (`videoLicense=creativeCommon`), (c) user-paste "Show transcript".
  - OpenSubtitles (legality pending) · Netflix via Language-Reactor pattern (later) · TikTok/IG → audio→STT (fragile).
- ⚖️ Derive word lists. **Never store/redistribute the full script.** All fetching → Privacy/ToS review.

### 🧩 Extension — browser capture surface

#### Browser extension — universal capture surface `[new surface · extends #9/#18]`
- **Fits with ~zero new backend:** third client of the same Supabase + `translate` edge + `services/` (like web/native).
  - Keyed on `auth.uid()`, RLS-protected → a save touches only that user. No new authz.
  - Reuses `saveDictionaryWord`/`createCustomWord`/`analyze()`. (Platform-portable-core, #18.)
- **Account link:** sign into a **real (email) account** in the extension → same `auth.uid()` → shared vocab across web + iOS + extension.
  - Guest can't sync (per-client) → reinforces account-linking (#13).
- **Generalization = tiered adapter registry.** Pipeline fixed: `page → [adapter] → analyze() → services/ → account`. Only the bracket varies (like `senses/registry.ts`).
  - **T0 — selection (universal, no per-site code):** highlight → "Add to DINO / Analyze." Everywhere, now.
  - **T1 — Readability (one adapter):** "analyze this page" → article body. Random pages + NHK + blogs.
  - **T2 — per-site (curated, high-maintenance):** YouTube captions · X · TikTok/IG. Few selectors each. Social DOMs churn + fight automation → real upkeep. User-initiated, per-page. Never bulk-scrape.
- **Extension vs native split** (neither does the other's job):
  - Extension = text on the open web (articles/NHK/X/social captions).
  - Native = audio/video/camera on device (TikTok/YouTube speech → free STT/OCR, #18).
  - Short-form video's spoken layer = native, not extension.
- **Capability ceiling — can reproduce the whole reader; the limit is the HOST PAGE.** Two modes:
  - **Mode A — in-place, lightweight** (almost everywhere; Yomichan/10ten-style):
    - highlight → floating "add to [sub-list]" bar (lists from DB).
    - hover → definition popup: senses/readings + your `✓ n/5` confidence.
    - Novel: it knows YOUR SRS state (plain dicts don't).
  - **Mode B — full scan → side panel** (Chrome Side Panel; robust on any site incl. SPAs — text lifted into OUR surface):
    - stats/graphs + deduped list + colored reader + quiz-new (#9).
  - **Complex pages** (panel layout is fixed — narrow single-column reader, never inherits the page; work is upstream: what text / how chunked):
    - Article → Readability (one body).
    - Complex/multi (homepage, feed, cards, comments) → block-model extractor → list of sections.
    - Known site → T2 adapter gives unit boundaries free.
    - Ambiguous → T0 selection.
    - Feed scoping: "analyze this post" = DOM subtree under cursor/viewport, not the whole page.
    - ⚠️ Reading order (2D→1D): DOM order ≈ reading order, but CSS `order`/grid/absolute + vertical JA break it. Same class as `readingOrder.ts`. Degrades to slightly out-of-order (moot after dedup).
  - **In-place coloring** (red→green): fine on static (NHK/blogs); fragile on SPAs (re-render wipes spans). Prefer Mode B there.
- **Legal — ONE story for every source:** extraction in the user's own session (private use); persist **derived word lists only** (Art. 30-4), never source. Collapses N ToS fights into one.
- **Build + gotchas:**
  - Separate **Manifest V3** codebase (content script + service worker + side panel). Reuses `services/`.
  - supabase-js in an MV3 worker → custom `chrome.storage` adapter.
  - edge `ALLOWED_ORIGINS += chrome-extension://<id>` (like `capacitor://localhost`).
  - Only the publishable/anon key in the extension.
  - Email/password sign-in (OAuth-in-extension is painful).
  - `functions.invoke`, not a custom HTTP wrapper (CapacitorHttp lesson).
  - kuromoji ~17 MB dict for JA (bundle vs lazy-load).
  - YouTube/social host-permissions → Chrome Web Store review.
- **Sequence:** additive like native. After MVP launch + account-linking (#13). Sync rests on real accounts.

### 🌐 Websites & their requirements
Same pipeline. Each source differs by **how we get the text**, its **legal footing**, and the **surface**:
- **App** = full in-app. We can **import the text word-for-word** (own license — PD / CC-BY / CC-BY-SA — or user-provided) → read + analyze in-app.
- **Lim App** (limited) = **can't import word-for-word.** Copyrighted / ToS-restricted → **link out / embed the source** + show **derived analysis only** (stats + word list). The extension can still overlay in the user's own session.

| Source | Content | How we get text | Legal footing | Surface |
|--------|---------|-----------------|---------------|---------|
| Generic web page | text | Tier 0 selection / Tier 1 Readability | derived, in-session (ext) or Art 30-4 (server) | **Lim App** (App if user-pastes) |
| **NHK** (news / Easy) | text (Easy = graded + furigana) | RSS headlines → link-out; ext in-session; user-paste | Art 30-4 derived + **link-out, NO re-host**; pursue license | **Lim App** |
| **Wikipedia** | text, topic-rich | MediaWiki API (`prop=extracts`, CORS-OK) | **CC BY-SA → re-host + store OK** (attribute + share-alike) | **App** |
| **Wikinews** | text (news) | MediaWiki API | **CC BY → re-host OK** | **App** |
| **VOA Learning English** | text (graded EN) | RSS / scrape | **Public domain → re-host OK** | **App** |
| Global Voices | text, multilingual | RSS | **CC BY 3.0 → re-host OK** | **App** |
| **Aozora Bunko** | JA literature (old/formal) | bulk DL / API | **Public domain → re-host OK** | **App** |
| Project Gutenberg | EN books | bulk DL | **Public domain → re-host OK** | **App** |
| **YouTube** | video + captions | iframe embed; captions via ext in-session / CC-BY videos / user-paste (⚠️ official API = own videos only; `timedtext` ToS-gray) | copyright: derived (Art 30-4) or CC-BY reusable; **ToS: no server scrape** | **Lim App** (embed + captions) |
| **X / Twitter** | short text | Tier 2 adapter / selection | derived, in-session; **ToS hostile to scrape** | **Lim App** |
| **TikTok** | video + caption | caption text via DOM (easy); speech → STT/OCR (hard) | derived, in-session; ToS hostile | **Lim App** |
| **Instagram** | image + caption | caption via DOM; image → OCR | derived, in-session; ToS hostile | **Lim App** |
| `.srt` upload | subtitle text | user upload | user-provided, private use | **App** |
| Kitsunekko | anime JA subs | download | legality via review; **derive lists only** | **Lim App** |
| OpenSubtitles | subs | API | legality pending | **Lim App** |
| Netflix | video + subs (DRM) | Language-Reactor ext pattern (in-session) | in-session only, NO re-host | **Lim App** (much later) |

**Requirement rules (the three that decide everything):**
- **Re-host vs link-out:** PD / CC-BY / CC-BY-SA → fetch, store, re-serve OK. Copyrighted (NHK/YouTube/social) → derived + link-out/embed only, never store prose (Art 30-4). Avoid CC **NC/ND** (commercial).
- **Server-fetch vs in-session:** server fetch OK for open-licensed + Art-30-4 analysis. Platform ToS (YouTube/X/TikTok/IG) forbids server scrape → extension (user session) or user-paste.
- **Adapter tier:** T0 selection (any page) · T1 Readability (articles) · T2 per-site (social/video).

### ⚙️ General — cross-cutting media infra

#### MT cost at scale — sentence cache + provider cascade `[cost · pressure from media features]`
Media features multiply **sentence-gloss** calls. Word-by-word = free (JMdict cache); context always needs MT. Google spend skyrockets at scale. Fix VOLUME first, then price.
- **Lever 1 (biggest): shared `sentence_cache`.** Key = `hash(normalized_text, source, target)` → gloss.
  - Inverts `persist:false`: a unique paste isn't worth caching; shared media (same NHK/anime across users) = high hit rate.
  - Two-level with `words` (words + sentences).
  - Also: lazy on-demand gloss (translate on tap) + within-doc dedupe (subs repeat).
- **Cascade (quality-first, cost-second):** `sentence_cache → DeepL (free) → Google` **[edge]** → **Apple** **[native iOS, offline last-resort]**.
  - ⚠️ Apple is NOT a server step — the edge can't call an on-device framework. Native-client fallback only (iOS 17.4+). Quality: gist, below DeepL/Google on complex/keigo/news. Spot-check first.
  - **DeepL Free:** ~500k chars/mo, ja↔en, commercial-OK. Signup + card. Key `:fx`, form-encoded. Small at scale → low-volume quality boost, not the fix.
  - Default TODAY = Google. DeepL + Apple are additions.
- **Switch trigger:** per-provider global counter (like `global_translation_usage`). Reserve vs DeepL 500k; exhausted → reserve vs Google. Catch DeepL **456** as backstop.
- **Seam:** `callTranslationProvider` → ordered provider chain, per-provider adapters (like `resolveSenseProvider`).
- **Also on the table:** self-hosted OPUS-MT/Argos (free, CC-BY/MIT, flat compute — ⚠️ avoid NLLB, CC-BY-**NC**) · Haiku-as-MT (better context, one bill with the AI-agent key) · ML Kit/Apple on-device (free on native).

#### Saving media translations — storage estimate `[cost/storage]`
- **Schema:** `sentence_cache(text_hash, source_lang, target_lang, gloss, created_at, hit_count)`. Store the **hash**, not the prose (saves ~40% + better legal posture).
- **Per-row ≈ 250 B:** hash (16–32) + gloss (~120, compresses 2–3×) + langs/ts/count (~24) + tuple (~28) + index (~40–60).
- **Volume (~250 B/sentence):**

  | Unit | ~Sentences | Storage |
  |------|-----------|---------|
  | 1 NHK Easy article | ~20 | ~5 KB |
  | 1 anime episode | ~350 | ~85 KB |
  | 100 episodes | ~35k | ~8.5 MB |
  | 1,000 episodes | ~350k | ~85 MB |
  | 5,000-episode catalog | ~1.75M | ~425 MB |
  | 1M unique sentences | 1M | ~250 MB |

- **Takeaway:** individual media is trivial (KB/article, ~100 KB/episode). Concern only in the hundreds of MB — thousands of episodes / tens of thousands of articles. Text compresses.
- ⚠️ Shares the 500 MB Free tier with JMdict (~243 MB) + embeddings → **Free→Pro trigger**. Non-issue on Pro (8 GB).
- **Bounded + tunable:** LRU/TTL by `hit_count` · or cache only popular/curated (persist after N requests). A policy knob, not a runaway.
- **MEASURED — ja.wikinews, the whole corpus (2026-07-28).** The Media tab's source is a *static, bounded* archive, so it's the one corpus we can cost exactly. Pulled every mainspace non-redirect page (`generator=allpages` + `rvprop=size`), calibrated wikitext-bytes → plaintext-chars on 25 full extracts (**ratio 0.19** — Wikinews prose is ~80% markup: source lists, categories, templates):

  | | |
  |---|---|
  | Articles | **4,118** |
  | Chars/article (JA plaintext) | mean **709** · median 629 · p90 1,068 · p99 2,074 · max 11,893 |
  | Whole corpus | **~2.92M chars** (±15%) |
  | Google v2 @ $20/M | **~$58** one-time · ~$48 net of the 500k/mo free tier · **$0** dripped over 6 months |
  | Storage | ~8.8 MB JA + ~5–6 MB EN ≈ **~15 MB** raw (≈65k sentences ≈ 16 MB at the 250 B/row model above) |

- **Decision: LAZY FILL, not bulk pre-translation.** On-demand costs 709 chars ≈ **$0.014/article-view**, so the $58 bulk run breaks even at ~4,100 views = *one view of every article*. Below that you pay for articles nobody opens; the lazy `sentence_cache` converges to the identical end state with zero upfront spend, and a bulk backfill stays available later for offline/no-first-view-latency. Storage was never the constraint here — 15 MB against JMdict's 243 MB.
- ⚠️ **A bulk backfill must NOT go through the edge function** — 2.92M chars would blow the 2M/mo `GLOBAL_MONTHLY_CHAR_QUOTA` and 429 every real user mid-run. It'd be an offline service-role script (like `ingest-jmdict.ts`) calling Google direct, batching multiple `q` per request (~128 segments / 30k chars → ~150–250 requests). The lazy path is fine on the edge but wants its own meter, not the user's.
- **Legal (Wikinews specifically):** CC BY 2.5 → storing the prose AND serving a derivative translation are both permitted with attribution + link-back (already rendered by `ArticleView`). No ShareAlike clause in 2.5. Contrast the NHK posture above (derived + link-out only).
- **Checked, not worth special-casing:** only **323 / 4,118 (7.8%)** ja.wikinews articles have an English sister article via `langlinks`, and those are independently written, not aligned translations.

</details>

---

<details open>
<summary><h2>🐞 Bugs · scalability · hardening</h2></summary>

### Scalability — mostly handled (#28); one residual
**EN→JA reverse-gloss regex scan** — *low priority, not a launch risk*
- **Done (#28, `20260726`):** headword resolution materialized → PK join, not ~5 correlated subqueries/candidate. WordNet "run" 1009→298 ms; edge skips the gloss scan for stopwords ("the" 8.8 s→~1 s).
- **Left:** the `gl.text ~* '\yword\y'` regex-over-trigram scan (`20260618_jmdict.sql`). No flat `gloss_terms` table.
- **Measured (full 217k JMdict, local):** 83–418 ms. Fallback path only (WordNet leads EN→JA). Cache-absorbed on repeat.
- **If it matters:** materialize `gloss_terms(term, entry_id, rank)` (btree on `term`).

### Test coverage
**Edge error-log — e2e trigger open**
- Covered: the sink contract (`error-log.integration.test.ts`, gated).
- Not covered: driving a real failing edge path (`translate_batch_failed` / `words_upsert_failed` / `translate_handler_crashed`). Not deterministically forceable over HTTP.

**Native simulator smoke** (XCUITest/Appium)
- Only layer exercising CapacitorHttp + `functions.invoke` + real CORS **together**.
- The CapacitorHttp regression that HUNG `invoke` had no test — each layer is tested with the others stubbed.
- Until justified: keep a manual device checklist.

### Security (2026-06-28 audit)
**[ops] Rotate the Google Translation key**
- In `supabase/functions/.env`. Bounded (API-restricted + `GLOBAL_MONTHLY_CHAR_QUOTA`) → hygiene, not urgent.
- Keep it only in `supabase secrets` / local dev.

**[MED] Enable captcha in prod** — code ON MAIN (`src/services/captcha.ts`), inert without `VITE_TURNSTILE_SITE_KEY`
- **Order matters** (server requires a token once on): (1) deploy client with real sitekey → (2) enable Attack Protection with matching secret.
- **Blocked — native:** Turnstile can't run under `capacitor://`; `build-ios.sh` defaults to PROD → flipping it kills anon sign-in on iOS.
- Founder call (2026-07-13): **account merging lands first.**
- Then: point dev devices at staging · OR `https://` WebView scheme + registered hostname · OR swap to hCaptcha (native SDKs).
- Cost of waiting: low. IP rate-limit still applies; paid MT capped; guest sweep reclaims bloat.

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
- **Scope: SQL ranking only.** `jmdict_lookup` can't prefer the learner-default reading (a reading is polluted by the kanji's *other* reading).
- Curated `readingOverrides.ts` is the only lever (applied in `lookupWord`). Already fixes 前→まえ, もの→物, 形→かたち, ところ→所. **Don't re-file those.**
- Real fix needs per-(kanji, reading) frequency — wordfreq lacks it (see Frequency sources).
- Blanket curated list: **ruled out** (~4,169 ambiguous frequent words, many context-dependent). Extend by hand only.
- Override applies in `lookupWord`, NOT `lookupWordsBatch` (reader path) — mostly moot; reader uses kuromoji context.

**General no-context ambiguity**
- Single-kanji lookups have no clean default. Long-term UX = **multi-reading display** (top 2–3), not one guess.
- In-sentence is already fine (kuromoji has context).

**次→つぎ override guard**
- Guard the reader's single-reading override against orphaned single-kanji fragments from an over-segmentation split.

**EN long-tail irregulars**
- Ingest Princeton `verb.exc` / `noun.exc` (bundled `lemmaCandidates` = common forms only).
- Optional: push EN lemmatization into SQL (`wordnet_en_ja_lookup`), then un-skip the SQL spec.

**Counter polish**
- Inline furigana ruby (data ready) · rare specialist-counter tail · context-variant numbers (4 = よん/し/よ).

**Troublemakers — re-tested live vs full JMdict 2026-07-13 (4 of 9 FIXED):**
- **Still wrong:** はし→階 (want 橋/箸/端) · 主→おも (want しゅ/ぬし) · 角→かく (want かど) · かえる→変える (want 帰る too; marginal, f=463 vs 466).
- **Fixed — don't re-file:** ところ→所 · 形→かたち · もの→物 · 前→まえ · 市→し (via `readingOverrides.ts`).

</details>

---

<details open>
<summary><h2>✨ Quality Improvements</h2></summary>

Where OUTPUT quality is **capped** — ceilings, not bugs.
Each = what's **lacking** → the **miss** (quality consequence). ⬛ = omitted for **space/storage** (blows the 500 MB Free tier).
Full ledger: `docs/QualityLimitations.md`.

### 🇯🇵 Japanese
- **Full dict vs common subset (dev/seed)** ⬛
  - Dev + seed ship the ~22.6k `-common-` JMdict, not full ~217k (~243 MB).
  - Miss: non-common words (esp. compounds like 唐揚げ, unrankable by wordfreq) return **empty** locally → MT only.
  - Prod runs full dict → a seed-size tradeoff, not a prod gap.
- **Per-(kanji, reading) frequency**
  - wordfreq is per-surface; no per-reading count.
  - Miss: can't pick the learner-default reading for homographs (市→いち/し · 主→おも/しゅ · 角→かく/かど). Only `readingOverrides.ts` patches known cases.
  - Fix: build our own (MeCab+UniDic over JA Wikipedia).
- **Word-map model** ⬛
  - Live vectors = `multilingual-e5-small` (384-dim).
  - Miss: katakana loanwords cluster by **spelling, not meaning** (ストライカー→streaker/stripper; real match ピッチャー ranks last).
  - Fix: e5-large (1024-dim). Needs ~2 GB model + full re-embed + ~415 MB vectors → over Free cap.
- **Embedding coverage floor** ⬛
  - Only common ∪ freq≥250 (~41k) eligible; live vectors still common-only ~22.6k.
  - Miss: rare words get **no word-map at all**. Full-dict = Pro storage.
- **Per-sense granularity**
  - Proficiency / frequency / embeddings all per-surface.
  - Miss: a homograph (辛い からい/つらい) gets **one blended** band/freq/vector. Sense precision lost.
  - Unlock: engineering, not money.
- **Furigana**
  - Group ruby only; per-kanji align (`alignFurigana`) deferred.
  - Miss: reading over the whole term, not per kanji (学校 = one ruby).
- **kuromoji readings (sentences)**
  - Best-effort; mis-reads short/ambiguous fragments.
  - Miss: paragraph furigana is a **hint**, not authoritative. Verified `words` readings = source of truth.
- **Ease-curve calibration**
  - JA POS offsets + anchors tuned to JLPT (a proxy), not fit to real `review_log`.
  - Miss: leveling ease is approximate until fit against volume.

### 🇬🇧 English
- **No English POS source (the big one)**
  - `words.part_of_speech` on EN rows = JMdict **Japanese** tags for the translation (pension → `{n, adj-no}`). No English POS at all.
  - Miss: EN leveling gets CEFR anchors only, no POS offsets → ease leans entirely on CEFR; frequency path can't be safely corrected (JA can).
- **Frequency source**
  - EN uses generic wordfreq, not **SUBTLEX-US** (better learner/spoken fit; CC-BY-SA + commercial).
  - Miss: difficulty axis less aligned to real exposure.
- **English embeddings absent** ⬛
  - No EN word-map (JA-only).
  - Miss: "Explore related words" **hidden** for EN learners; #12 domain-quiz can't run for EN.
  - Storage hog (~80 MB+) → the real **Free→Pro trigger** for English.
- **Reader-side lemmatizer**
  - EN→JA lookup lemmatizes (edge `lemmaCandidates`); reader side doesn't.
  - Miss: inflected EN in a paste (ran/running) may not resolve to lemma.
- **Long-tail irregulars**
  - Princeton `verb.exc`/`noun.exc` not ingested (common forms only).
  - Miss: irregular EN forms mis-lemmatize.
- **EN→JA sense quality**
  - WordNet synsets lead + gloss fallback; grouping not live-verified.
  - Miss: sense order/grouping may be off (spring 春/泉/ばね unvalidated). Tune fallback merge size.

### Cross-cutting
- **Per-sense axis** (JA+EN) — biggest lever that costs engineering, not money.
- **Prod embedding regen at deploy · HNSW tuning under load · KO/ZH word-maps.** New lang = own dict source + `<source>_lookup()` + `related_words`.
- **Top-3 money levers** (`docs/QualityLimitations.md`): bigger model + full-dict embeddings (→Pro) · per-sense (→engineering) · English embeddings (→Pro).

</details>

---

<details open>
<summary><h2>➕ Open follow-ups</h2></summary>

### Custom domain + email deliverability `[launch polish · partly URGENT]`
- **Status (2026-07-13):** prod email **works but lands in spam.** Brevo delivers (reset = `DELIVERED`). Sender = Brevo-validated `dinolanguagestudy@gmail.com`. Auth rate limit 2→30/hr.
- **Why spam:** sender is `@gmail.com`; `gmail.com` authorizes only Google's servers (SPF `redirect=_spf.google.com`) → SPF/DKIM **never** align through Brevo.
- **Fix (one task, 3 payoffs):** register a domain (~$10/yr, Cloudflare Registrar) → authenticate in Brevo (SPF/DKIM/DMARC; **zero authenticated domains today**) → send from `noreply@<domain>`.
- **Also fixes:** app URL (`dino-86y.pages.dev`) → update Supabase Site URL/redirects + edge `ALLOWED_ORIGINS` + Google origins.
- **Google consent branding:** needs a Supabase custom auth domain → **Pro**. Interim: consent App name = DINO (free).
- **Careful:** staging (`jfcb…`) has **no SMTP** — auth emails there go nowhere. Test reset flows locally (Inbucket, `:54324`).

### Downstream difficulty-axis reconciliation `[#8 · design call]`
- WORD difficulty is now proficiency-preferred (`override ?? proficiency ?? frequency`).
- **Conflict:** (a) `users.level` now drifts proficiency-ward ≈ `users.proficiency_band` (redundant); (b) #12's domain filter + `seedStability` want a **dense frequency** axis for bandless neighbours.
- **Pick one:** keep `users.level` explicitly frequency, OR go proficiency-preferred everywhere + let bandless words fall to frequency.
- Low-urgency (±1 window absorbs it). Decide **before #12 ships**. Don't over-promise JLPT precision in UI copy.

### Frequency sources — supplement wordfreq `[#8]` — see `docs/research/Frequency_Sources.md`
- **English:** add **SUBTLEX-US** (best learner fit; CC-BY-SA + commercial) → upgrades `data/frequency/en.tsv`.
- **Per-reading JA** (only license-clean path = build our own): MeCab (BSD) + UniDic over a JA Wikipedia dump (CC-BY-SA) → count on `(語彙素, 語彙素読み)`, join by surface AND reading. Feeds the 前→まえ fix.
- Not urgent — surface baseline correct post-`20260720`.
- **Avoid:** BCCWJ lists (research-only) · NTT · jpdb/anime scrapes · COCA. Optional spoken axis: TUBELEX (BSD-3).

### Proficiency label axis — remaining `[#8 sibling]` — see `docs/Proficiency.md`
Pipeline, ingest, projection, resolver, learn/calibration: **DONE + LIVE** (prod + staging), test-covered. Left:
- **UI badge — half done.** `WordInfo.tsx` renders `getProficiency()`, wired into **ListRow** + **FlashcardCard**. Remaining: **translate result head** + **reader hovercard**.
- **Live-verify the Learn tab** on a device (unit + RPC tests pass; only the device run is unverified).

### English as a learning target
Works today (EN→JA reverse-JMdict, uk-correct). EN frequency + CEFR bands LIVE. Left, cheap-first:
- **SUBTLEX-US** frequency upgrade (above).
- **English lemmatizer** (`ran/running → run`) for the **reader** side. Lookup already lemmatizes via edge `lemmaCandidates`; reader-side lemma is absent.
- **English embeddings / word-map** (#11) — storage hog (~80 MB+), the real Free→Pro trigger. "Explore related words" stays hidden for non-JA learning langs until then.

### Legal — Privacy/ToS counsel review `[§10]`
- `/privacy` + `/terms` drafted + footer-linked. Remaining: **counsel review before going truly public.**
- Bump `CURRENT_TERMS_VERSION` (`src/lib/terms.ts`) when reviewed copy lands.

### Account-linking edge cases (email ↔ Google) `[#13]`
- **Gates the captcha rollout** (see Security).
- TODO: collision messaging ("this email signs in with Google — use that") · claim/merge story · guest-carry decision for sign-in-Google · verify auto-link live.
- Cases: `linkIdentity` needs `security_manual_linking_enabled` · email + later-Google auto-links only if email CONFIRMED · Google-first then email/password has no set-password UI · guest → sign-in-Google switches uid, so guest words don't carry.

### Source-language mismatch robustness `[translate UX]`
- Concrete source mismatching the script (source=JA, Latin input) → garbage.
- Fix: in `resolveSourceLanguage` / `useTranslate.submit`, if `detectLanguage` strongly disagrees on SCRIPT → override to detected (or warn). Low-risk.

### Very low priority
- **Real furigana (#16)** — ruby above kanji + peel-matching-kana alignment (`alignFurigana`). Group ruby correct meanwhile.
- **FSRS (#19)** — SRS to D/S/R (power-law, fit to `review_log`). New `record_review()` body, same API. HLR fine for now.

</details>

---

**To publish (non-code):** Privacy/ToS counsel review + Production Rules console hardening. Admin tooling · Quality Improvements · Features are post-launch.

**🧪 Pre-publish QA gate:** re-run the multi-agent pre-publish review before any published build / after any major change.

---

<details>
<summary><h2>📋 Production Rules — ongoing checklist (hosted-only, live prod console)</h2></summary>

Not a to-do — standing rules + hosted toggles for the live instance. Items 2–4 done. None blocking launch. Numbers preserved.

**5. Forward-only migrations** `[§11]`
- Never edit an applied migration (prod has data; no `db reset`).
- Process, not a task.

**6. Automated backups + PITR** `[§2]`
- Needs **Pro** (Free has none): flip toggle + schedule `db:backup` off the DB host.
- Tooling done. Interim: run `db:backup` manually/cron.

**7. Observability — alerting** `[§9]`
- Point edge structured logs at hosted alerting. Watch: spend, 5xx, uptime.
- Emitted: `mt_spend` · `request` · `global_cap_reached`. **No `health` EVENT** — `/health` responses fall through the generic `request` line.

**8. Confirm pg_cron jobs registered on prod/staging**
- Guest sweep (`20260727`, weekly) + `idempotency_keys` prune (`20260712`).
- Both silently **no-op** without pg_cron. Do a `dry_run` pass first.

</details>

<details>
<summary><h2>⏳ Awaiting merge — code done, just merge</h2></summary>

| PR | What | Note |
|----|------|------|
| **#30** | CORS default-to-deny · error-`kind` rendering · recognizer memoization | LOW security cluster. CORS still defaults to `*` (`index.ts`) → not yet merged. |

*Landed 2026-07-13: #24 publishable key · #32 captcha + guest sweep · #34 stale-cache read gate.*
*Closed obsolete: #22 · **#31** (EN→JA sense ordering — superseded by #29, verified on branch `c118b14`).*

</details>

<details>
<summary><h2>🛠 Admin tooling</h2></summary>

**Shipped:** `AdminPage.tsx`, gated by `is_admin` — panels: Usage · API health · Grants · Errors · DB size (migrations `20260704`–`20260708`).

**Remaining panels / logs:**

**Edit `words` cache** — re-projection sweep (#3) — *downgraded 2026-07-13*
- **Correctness SOLVED** — shipped in #34, on `main`. Stale rows are a cache MISS and re-project in place on next use: `FRESH_OR_MT` gate (`src/lib/projection.ts`) in both edge read paths + all 3 client repo call sites; `CURRENT_PROJECTION_VERSION = 7` (drift-guarded by `tests/services/projection-version.test.ts`); MT rows exempt. Covered by `tests/integration/stale-cache.integration.test.ts`.
- **Left — STORAGE chore:** rows the current projection no longer emits are never served but still occupy the 500 MB free tier.
- **Left — destructive merge/repoint:** still gated on a test harness.
- Optional: eager warming vs lazy healing.

**Translation / MT call log**
- Per request: input length · path (JMdict·WordNet·MT) · cache hit/miss · est. cost · latency · anon user.
- Persist edge's `mt_spend` stream → spend + provider mix queryable.

**Quota / limit-hit events**
- Log every 413 (`paragraphCharLimit`) + 429 (`monthlyCharQuota` · `GLOBAL_MONTHLY_CHAR_QUOTA` · `MT_DISABLED`), with cap + user.

**Auth / account audit**
- Append-only: sign-up · upgrade · sign-in/out · reset. Who + when, never passwords.
- Deletion already covered by `account_deletion_log`.

**Admin-action audit**
- Partial: `feature_grants.granted_by` + `provider_status.updated_by` stamp an actor.
- Missing: a real audit table (action · target · admin · time). Prune is unaudited; re-projection has no admin action yet.
- The surface must audit itself (grants are never-revoke).

**Content-safety blocks**
- `services/contentSafety.ts` filters but records nothing.
- Log `isExplicitSuggestion` hits (input + where) → monitor false pos/neg + abuse.

**Edge health / latency**
- Surface emitted health/request logs: p50/p95, status mix, 5xx. In-app half of Production Rules #7 (observability).

**Log retention + privacy**
- Done: admin-only read (RLS + `is_admin`-gated `admin_error_log`). `idempotency_keys` prunes (7d, daily cron).
- Left: **retention window for `error_log`** (raw input, 500-char truncated → PII) + bucketed user ids in aggregates.
- ⚠️ **Not a drop-in:** `error_log` is deliberately un-prunable — `20260706` REVOKEs DELETE/TRUNCATE even from `service_role`. Retention needs a migration re-granting DELETE, trading against the append-only guarantee. Decide which wins.

**API health: auto-pull real usage**
- Auto: Google MT chars (`admin_provider_health` reads `global_translation_usage` live).
- Still manual (`credential_expires_at` + `quota_note`): **Brevo** send count (v3 key works — `BREVO_API_KEY` in `.env.deploy`) · **Google** quota + OAuth secret expiry · **Supabase** billing caps.

</details>
