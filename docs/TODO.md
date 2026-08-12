# DINO — TODO (Launch + Roadmap)

Remaining work only. Shipped → git history, `tests/`, `docs/`.
Tags: `[concern]` raised directly · `[#N]` roadmap · `[§N]` `Production_Hardening.md`.
Order **topical, not priority** — priority is in each note.

**Where does a thing go?** 🚀 = not built · 🧱 = built, room to grow · 🐞 = broken ·
✨ = as good as the data allows (a ceiling, not a bug). One item, one section — if it
looks like it belongs in two, it goes in the more specific one and the other links to it.

---

<details open>
<summary><h2>🚀 Features to add</h2></summary>

Post-launch: media study · AI. **Nothing here is built** — anything already shipped is in
🧱 Extendable Features.

- Rule: **free on-device on native (#18); paid/heavy on web.** See CLAUDE.md `#18`.
- Core (`analyze()` → `services/` → account) is identical across surfaces; only intake differs.

### 📱 App

#### AI agents — generative study aids `[extends #12]`
- **Cost:** `ANTHROPIC_API_KEY` secret + generations/month quota, through the existing
  reserve-before-call seam. Hard `max_tokens`; cache outputs like `words`.
- **Feature:** domain paragraph quiz ("paragraph at level X from these seeds").
- **Fork:** an LLM collapses #11/#12 into one call — less infra, per-use cost, less
  determinism. Recommended hybrid: embeddings for level-aware selection, LLM only for
  generation (~$0.0017 Haiku / $0.005 Sonnet per call).
- ⚠️ **Billing must land in parallel.** Everything here is per-use paid; `user_limits` +
  reserve exist, the Stripe/plan half doesn't. Set free-vs-paid limits **before launch**.

#### Sense enrichment — example sentence + JA definition per meaning `[ingest-time]`
Each SENSE gets a Japanese example + English gloss, and a Japanese-language definition.
Surfaces in the reader hover card, the flashcard back, and Lists detail.

- **Why per-sense:** a gloss list can't separate 辛い からい/つらい — a sentence can.
- **Generated at INGEST, not runtime:** a committed data file → no per-user cost, no quota,
  no edge secret, reviewable in a diff. Removes a planned paid feature.
- **Storage:** server-only `jmdict_sense_example (entry, sense_pos, example, example_gloss,
  definition_ja)`; edge projects onto nullable `words.*` columns. Bump
  `CURRENT_PROJECTION_VERSION` so cached rows re-project.
- **Scale + cost** (measured on prod): ~280 B/row. Senses by headword frequency ≥500 =
  4,534 (≈1.3 MB) · ≥400 = 16,880 (≈5 MB) · all 251,734 (≈70 MB). Even full coverage fits.
  **The constraint is generation time, not space** — hand-write the ≥500 band (~30 turns),
  Batch API the tail.
- **Generation rules:** demonstrate THAT sense · natural JA in the word's register · short
  enough for a hover card · definitions written as a real monolingual dictionary would.
  - ⚠️ **No difficulty ceiling on supporting vocabulary.** Two drafts of that rule were
    tried and rejected (2026-08-01) — 「この部屋は書斎と客間を兼ねている」 is the natural
    sentence even though 書斎/客間 aren't easier than 兼ねる. **Do not re-impose.**
  - **The rabbit hole is the feature.** The JA definition renders through
    `ParagraphReader`, so every word in it is knowledge-coloured, addable and openable —
    and *its* definition is Japanese and tappable too. Escape hatch: per-definition
    switch to English.
  - ‼️ **So JA definitions need BROAD coverage, not just hard words** — a definition graph
    with holes stops being explorable the moment you tap a common word and hit nothing.
  - **What the JA definition carries that a gloss cannot:** collocation and negation
    habits. 遜色 glossed "inferiority" invites 遜色がある (unnatural); the definition says
    多くは「ない」を伴って使う.
- ‼️ **kuromoji-validation gate — every sentence must PARSE before it is finalized.** We
  author the corpus, so pick sentences that suit the parser rather than fixing the parser.
  Run each through the same `analyze()` the reader uses and reject-and-rewrite on failure:
  (1) target survives as ONE token with the right lemma · (2) reading matches the
  authoritative one · (3) no orphan content words · (4) offsets round-trip. Applies to the
  definition too. Doubles as a regression test over the whole file after any kuromoji or
  JMdict change.
- **Source for the JA definitions:** JMdict cannot supply them (glosses are target-language
  only). Japanese WordNet partially can — `wnjpn.db`'s `synset_def` has non-English defs,
  but `ingest-wordnet.ts:92` filters `d.lang = 'eng'`. Widening it + a `definition_ja`
  column is small, but **verify coverage first** (they read like translated English, and
  only synset-linked words are covered). Plan: WordNet where it exists, LLM the rest.
- **Serves both markets:** JA-native users get meanings in their own language; advanced
  learners get monolingual definitions.

#### Article library — headlines → analysis → link-out `[extends #9]`
RSS/API headlines → click → server-side fetch + analyze → **derived data only** → link out.
Derived = difficulty stats + a **deduped, reordered** word list + quiz-new.

- ⚖️ **Info analysis, NOT republication.** JP Copyright Act **Art. 30-4** (2018) permits
  reproduction for information analysis, including commercial — the strongest lever, and
  the founder is in Japan. US analog: Google Books / HathiTrust.
- Rule: word list deduped + reordered (doc order = a reproduction); **persist derived,
  never prose**; minimal snippets; counsel-confirm.
- **Not a downgrade — it IS the pre-study feature:** stats → quiz hard words → read primed.
- Re-hostable: Wikipedia (CC BY-SA) · Wikinews (CC BY) · VOA (PD) · Aozora (PD). Avoid CC
  **NC/ND**. Third-party news (NHK): analysis + link-out only; pursue a license long-term.

#### Media ingestion — subtitles/scripts → new words `[extends #9]`
Per-source adapter → plain text → existing reader/quiz. Core is free (kuromoji + JMdict).

- 🌟 **Flagship — pre-study a series:** episode/season subs → content words → dedup vs
  known → rank by frequency → flashcard.
- ⚠️ **Real constraint = JP subtitle supply.** Anime covered (Kitsunekko); live-action scarce.
- **Sources:** Kitsunekko · `.srt` upload (safe floor) · OpenSubtitles (legality pending) ·
  Netflix via the Language-Reactor pattern (much later).
- **YouTube captions are not the easy win:** the official API serves your own videos only,
  and `timedtext` is ToS-gray. Clean paths: browser extension (user session), CC-BY
  videos, or user-paste "Show transcript".
- ⚖️ Derive word lists; **never store or redistribute a full script.**

### 🧩 Extension — browser capture surface `[new surface · extends #9/#18]`

**Fits with ~zero new backend:** a third client of the same Supabase + `translate` edge +
`services/`, keyed on `auth.uid()`. Reuses `saveDictionaryWord` / `analyze()`.

**What the extension can do that the app cannot** — reach text on the open web *in the
user's own session*: articles behind a login, X/TikTok/IG captions, YouTube transcripts.
Server-side fetching of those is ToS-blocked; in-session extraction is not.

**What it cannot do, and the app must** — anything needing a device sensor or an on-device
model. This is not a gap to close; it is the split:

| | Extension | App (native) |
|---|---|---|
| Text on the open web | ✅ the whole point | user-paste only |
| Camera / OCR | ✗ (web OCR = paid Cloud Vision) | ✅ free, on-device |
| Handwriting | ✗ (no free web ink API at all) | ✅ free, on-device |
| Dictation | Chrome only (Web Speech) | ✅ free, on-device, offline |
| Spoken layer of video | ✗ | ✅ STT |

- **Two modes.** Mode A in-place (Yomichan-style): highlight → add-to-list bar; hover →
  senses + **your `✓ n/5` confidence** (the novel part — plain dictionaries don't know your
  SRS state). Mode B full scan → Chrome Side Panel: stats + deduped list + coloured reader
  + quiz-new; robust on SPAs because the text is lifted into our surface.
- **Adapter tiers:** T0 selection (any page, no per-site code) · T1 Readability (articles) ·
  T2 per-site (YouTube/X/TikTok — social DOMs churn, real upkeep, user-initiated only).
- **In-place colouring** is fine on static pages, fragile on SPAs (re-render wipes spans) →
  prefer Mode B there.
- ⚠️ **Reading order (2D→1D):** DOM order ≈ reading order until CSS grid/absolute or
  vertical JA breaks it — same class as `readingOrder.ts`. Degrades to slightly
  out-of-order, which dedup absorbs.
- **Legal — ONE story for every source:** extraction in the user's own session (private
  use), persist derived word lists only (Art. 30-4), never the source. Collapses N ToS
  fights into one.
- **Build gotchas:** Manifest V3 (content script + worker + side panel) · supabase-js in an
  MV3 worker needs a `chrome.storage` adapter · edge `ALLOWED_ORIGINS +=
  chrome-extension://<id>` · publishable key only · email/password sign-in (OAuth in an
  extension is painful) · `functions.invoke`, never a custom HTTP wrapper (the CapacitorHttp
  lesson) · kuromoji's ~17 MB dict (bundle vs lazy-load).
- **Sequence:** after MVP launch + account-linking (#13) — sync rests on real accounts.

### 🌐 Websites & their requirements

**App** = we can import the text word-for-word (own licence or user-provided).
**Lim App** = cannot import; link out / embed + show derived analysis only.

| Source | How we get text | Legal footing | Surface |
|---|---|---|---|
| Generic page | T0 selection / T1 Readability | derived, in-session or Art 30-4 | **Lim App** (App if pasted) |
| **NHK** (news / Easy) | RSS → link-out; ext in-session; paste | Art 30-4 derived, **no re-host** | **Lim App** |
| **Wikipedia** | MediaWiki API | **CC BY-SA → re-host OK** | **App** |
| **Wikinews** | MediaWiki API | **CC BY → re-host OK** | **App** |
| **VOA Learning English** | RSS / scrape | **PD → re-host OK** | **App** |
| Global Voices | RSS | **CC BY 3.0 → re-host OK** | **App** |
| **Aozora / Gutenberg** | bulk DL | **PD → re-host OK** | **App** |
| **YouTube** | embed; captions in-session / CC-BY / paste | derived; **ToS: no server scrape** | **Lim App** |
| **X · TikTok · Instagram** | T2 adapter / selection | derived, in-session; ToS hostile | **Lim App** |
| `.srt` upload | user upload | user-provided, private use | **App** |
| Kitsunekko · OpenSubtitles | download / API | legality via review | **Lim App** |
| Netflix | Language-Reactor pattern | in-session only, no re-host | **Lim App** (much later) |

**The three rules that decide everything:** (1) PD/CC-BY/CC-BY-SA → fetch, store, re-serve;
copyrighted → derived + link-out only. (2) Server-fetch is fine for open licences and
Art-30-4 analysis; platform ToS forbids it → extension or paste. (3) Adapter tier T0/T1/T2.

### ⚙️ MT cost at scale — sentence cache + provider cascade `[cost]`

Media multiplies **sentence-gloss** calls (word-by-word is free from the JMdict cache).
Fix VOLUME first, then price.

- **Lever 1 — shared `sentence_cache`**, key `hash(normalized_text, source, target)`.
  Inverts `persist:false`: a unique paste isn't worth caching, but shared media across
  users has a high hit rate. Plus lazy on-demand gloss and within-doc dedupe.
- **Cascade:** `sentence_cache → DeepL (free ~500k/mo) → Google` **[edge]** → Apple
  **[native only, offline last resort]**. ⚠️ Apple is not a server step — the edge cannot
  call an on-device framework.
- **Switch trigger:** per-provider global counter like `global_translation_usage`; catch
  DeepL **456** as a backstop. **Seam:** `callTranslationProvider` → ordered provider chain.
- **Storage:** `sentence_cache(text_hash, …)` ≈ 250 B/row — store the hash, not the prose
  (~40% smaller, better legal posture). 1 article ≈ 5 KB · 1 episode ≈ 85 KB · 1,000
  episodes ≈ 85 MB. Bounded by LRU/TTL on `hit_count`.
- **MEASURED — the whole ja.wikinews corpus (2026-07-28):** 4,118 articles, mean 709 chars,
  **~2.92M chars** total → **~$58** one-time at Google's $20/M, ~15 MB stored.
- **Decision: LAZY FILL, not bulk.** On-demand is ~$0.014/article-view, so $58 breaks even
  at one view of every article. The lazy cache converges to the same end state with zero
  upfront spend.
- ⚠️ **A bulk backfill must NOT go through the edge** — 2.92M chars would blow the 2M/mo
  `GLOBAL_MONTHLY_CHAR_QUOTA` and 429 every real user mid-run. It would be an offline
  service-role script calling Google direct.
- **Legal (Wikinews):** CC BY 2.5 → storing prose and serving a derivative translation are
  both fine with attribution + link-back (already rendered by `ArticleView`).

</details>

---

<details open>
<summary><h2>🧱 Extendable Features</h2></summary>

**Shipped and working — room to GROW, not work to start.** Each names what exists so nobody
rebuilds it.

### Media tab — deep analysis for longer works
- **Built:** `MediaView` (random ja.wikinews browse, ★ saved articles) → "Study" opens
  `ArticleView` (graphs + word table + reading mode + article-sourced quiz), plus the
  reader's "Quick summary" (`AnalyzeInfographic` + `services/analyze/summarize.ts`).
- **Grow into the deep version** for whole articles/episodes/seasons, same data core:
  - **Comprehension headline** — known ÷ in-dictionary words against reading thresholds
    (~95% comfortable · ~98% fluent · <90% hard): *"91% — challenging · 14 new words to
    reach 95%"*. The highest-value single stat.
  - **"Study these first"** — new words ranked by frequency → a "Quiz these N → 95%" CTA.
  - **Frequency × knowledge quadrant** — the one genuinely new chart: common+unknown =
    study now, rare+unknown = skip. A per-axis bar can't show it.
- **EN media source** — hardwired to Japanese Wikinews (`LANG = "JA"`, `MediaView.tsx:30`).
  Additive, not a rewrite.

### Camera / OCR — photo → text
- **Built:** Mode A on iOS (Apple Vision via `TextOcrPlugin.swift`, per-line boxes), camera
  **and** photo-library sources, crop-before-recognize, reading-order assembly.
- **Web:** nothing free — Cloud Vision is $1.50/1k (1k/mo free) and would need a per-user
  image quota in `user_limits`, edge-enforced. Tesseract.js is a rough fallback.
- **Vertical (縦書き)** is unhandled: the row-bucket sort is horizontal-only. Fix in
  `readingOrder.ts` — block geometry, columns x DESC, within-column y ASC.
- **Mode B (AR overlay):** tappable chips per box, then replace-in-place. The geometry
  already flows from `captureResult()`.

### Voice — live listener language handling `[design call]`
- **Built:** the live transcript (`useLiveTranscript` + `useLiveReader`) and read-aloud
  everywhere a word appears (`SpeakButton` + `services/voice`).
- The transcript recognizes the **learning** language, not the source selector — deliberate,
  since following `source` would stop it hearing Japanese the moment source went to English.
  Three things unfinished:
  - **The "native" side is GUESSED** — `SUPPORTED_LANGUAGES.find(l => l.code !== learning)`
    is positional, right for JA↔EN only by list order. `useTranslate` resolves it properly;
    thread that through. **Do before a third language ships.**
  - **No language control inside the transcript** — it follows the Translate tab.
  - **One language per session.** A bilingual conversation (the actual case in Japan) is
    recognized entirely as the learning language. On-device recognizers do no language
    identification, so the honest options are a manual toggle or accepting it.
- ⚠ **Untested on a device.**

### Speech-to-text — dictation into the translate box
- **Built:** the mic dictates into the input (`useDictation` + `services/speech`); each
  pause commits an utterance and the live reader colours it as it lands. Streaming on both
  backends, with a mock so the affordance stays reachable where neither exists.
- **Web:** Web Speech API — free but **Chrome only**, so no dictation in Safari/Firefox.
- **Android:** `SpeechRecognizer` (API 33+) — the additive half of the iOS-first scope call.

### Handwriting — "draw the character" `[iOS first]`
- **Built:** `HandwritingCanvas` + `services/handwriting`; recognized text appends into the
  input and flows through the existing `analyze()` → JMdict pipeline.
- **iOS:** ML Kit Digital Ink — on-device, free, ~20 MB model, wifi-once.
- **Web:** no free ink API exists, which is why the button is hidden there. Options are
  `inputtools.google.com` (ToS-gray) or rasterize → Cloud Vision. Stroke capture is
  trivial; recognition is the whole problem.

</details>

---

<details open>
<summary><h2>🐞 Bugs · scalability · hardening</h2></summary>

### EN→JA lookup is slow `[the one real performance item]`
- **Measured on prod 2026-08-07:** `jmdict_lookup` EN→JA takes **5.0 s for "one"**, 4.3 s
  "back", 2.9 s "own" — all CEFR A1 — against ~0.2 s for a B1 word. A frequent English word
  appears in a huge share of JMdict's glosses.
- **Already routed around** where it was fatal: the learn/placement path skips the gloss
  fallback entirely (`skipGlossFallback`), because the EN pool only emits surfaces WordNet
  can translate. That fixed A1/A2 placement timing out.
- **Still slow on the ordinary path** — typing "back" into Translate pays those seconds.
- **Fix if it matters:** materialize `gloss_terms(term, entry_id, rank)` with a btree on
  `term`, replacing the `gl.text ~* '\yword\y'` regex-over-trigram scan.

### Test coverage
- **Edge error-log e2e** — the sink contract is covered; driving a real failing edge path
  isn't (not deterministically forceable over HTTP).
- **Native simulator smoke** (XCUITest/Appium) — the only layer that would exercise
  `functions.invoke` + real CORS *together*. The CapacitorHttp regression that hung
  `invoke` had no test. Until justified: a manual device checklist.

### Security (2026-06-28 audit)
- **[MED] Enable captcha in prod** — code is on `main` (`services/captcha.ts`), inert
  without `VITE_TURNSTILE_SITE_KEY`. **Order matters:** deploy the client with a real
  sitekey *first*, then enable Attack Protection. ⚠️ **Blocked on native** — Turnstile can't
  run under `capacitor://`, and `build-ios.sh --prod` points at prod, so flipping it kills
  anonymous sign-in on iOS. Founder call (2026-07-13): account merging lands first. Then:
  point dev devices at staging, or use an `https://` WebView scheme, or swap to hCaptcha.
- **[LOW] `public.users.email` is client-writable and unverified** — enables squatting, and
  it's the lookup key in `admin_grant_feature`. Fix: a BEFORE INSERT/UPDATE trigger
  requiring `email` = verified `auth.users.email` or `<uid>@guest.dino`. On the
  session-create write path, so it needs an integration pass.
- **[ops] Rotate the Google Translation key** — hygiene, not urgent (API-restricted +
  globally capped).
- **[MED · scale-only] Global-quota advisory lock** — contention only bites at huge MT
  throughput; shard by hash bucket if it does.

</details>

---

<details open>
<summary><h2>✨ Quality ceilings</h2></summary>

Where OUTPUT quality is **capped** — ceilings, not bugs. Each: what's lacking → the miss.
⬛ = omitted for storage. Full ledger: `docs/QualityLimitations.md`.

### 🇯🇵 Japanese

- **Per-(kanji, reading) frequency — the root of every reading complaint.** wordfreq is
  per-surface, so a reading is polluted by the kanji's *other* reading and `jmdict_lookup`
  cannot prefer the learner-default one. Curated `readingOverrides.ts` is the only lever.
  - **Fixed, don't re-file:** ところ→所 · 形→かたち · もの→物 · 前→まえ · 市→し.
  - **Still wrong:** はし→階 (want 橋/箸/端) · 主→おも (want しゅ/ぬし) · 角→かく (want
    かど) · かえる→変える (want 帰る too; marginal, f=463 vs 466). Re-tested 2026-08-09.
  - A blanket curated list is **ruled out** (~4,169 ambiguous frequent words, many
    context-dependent). Extend by hand only.
  - Real fix = build our own counts: MeCab (BSD) + UniDic over a JA Wikipedia dump
    (CC-BY-SA), counting on `(語彙素, 語彙素読み)`. See `docs/research/Frequency_Sources.md`.
  - Long-term UX for single-kanji lookups is **multi-reading display** (top 2–3), not one
    guess. In-sentence is already fine — kuromoji has context.
  - Note the override applies in `lookupWord`, not `lookupWordsBatch`.
- **Per-sense granularity** — frequency is per-surface, proficiency per-entry
  (`20260740`), never per-sense. A homograph gets one blended band/frequency. Unlock is
  engineering, not money. **The biggest lever on this list.**
- **JLPT list coverage** — **1,656 of 6,604** JA rows carry no band (down from 3,100 after
  `20260740`). Those entries are absent from the Waller list, and every free JLPT list
  traces back to it. Unlock: a licensed independent list.
- **Furigana** — group ruby only; per-kanji alignment (`alignFurigana`) deferred.
- **kuromoji readings in sentences** — best-effort, mis-reads short fragments. Paragraph
  furigana is a hint; `words` readings are the source of truth.
- **Ease-curve calibration** — JA POS offsets and anchors are tuned to JLPT as a proxy, not
  fit to real `review_log` volume.
- **Full dict vs common subset (dev/seed)** ⬛ — dev ships the 22.6k `-common-` JMdict, so
  non-common compounds (唐揚げ) return empty locally and fall to MT. Prod runs the full
  dict; a seed-size tradeoff, not a prod gap.

### 🇬🇧 English

Everything English-specific lives here — the old "JA vs EN divergence" and "English as a
learning target" sections said the same things and are folded in.

The core (words/user_words/lists/SRS/quiz) is language-agnostic and identical both ways.
**Root cause of every gap below:** `analyze()` routes JA to kuromoji and everything else to
`segmentOnly` → `reading: null, lemma: null`, plus a POS only for known closed-class words.
It only bites when English is the **learning target**.

| Gap | Blocked on | Note |
|---|---|---|
| **EN POS tagger** | — | Widest blast radius: unblocks the two below and can tell the modal *can* from the noun *can*. |
| EN POS offsets in the leveling profile | the tagger | The one remaining leveling asymmetry (JA has anchors **+** offsets). |
| Proper-noun demotion | the tagger | JA demotes 人名/組織 via kuromoji POS; EN can't. Measured on en.wikinews (now the Media corpus for EN learners): **23.5% of lookup keys miss the dictionary vs 5.5% for ja.wikinews**, overwhelmingly names (*UEFA · Abidal · Piraquara · WMAR*) — each a paid MT call plus a cache row. |
| Reader-side lemma | — | *running* never resolves to *run* client-side; the edge lemmatizes for LOOKUP only. |
| Long-tail irregulars | — | Ingest Princeton `verb.exc`/`noun.exc` — bundled `lemmaCandidates` covers common forms only. |
| Case folding | — | The reader keys meanings on the raw surface, so sentence-initial `Cats` forks from `cats`. Small, independent. |
| Compound handling | — | JA has `compounds.ts`; EN has nothing (*bus stop* → two words). Marginal. |
| Frequency source | — | EN uses generic wordfreq; **SUBTLEX-US** (CC-BY-SA, commercial-OK) is the better learner fit. |
| EN→JA sense quality | — | WordNet synsets lead, gloss fills; grouping never live-verified (spring 春/泉/ばね). |

**Not gaps — do not file these.** Furigana, the reading/writing override tables, context
sense ordering (`senseOrder`) and potential-verb/する candidates all key on a **reading**,
which English does not have; sense examples + JA definitions are JA→EN by design.

**Already at parity — don't re-derive:** dictionary lookup, MT fallback, corpus frequency,
proficiency bands, the Learn-tab band pool (`20260745`, measured 915 · 1,973 · 748
candidates at A1 · B1 · C2), and grammar-word filtering (`functionWords.ts`).
- ⚠️ The function-word list **under-reaches on purpose** — surface matching with no POS, and
  the costs are asymmetric (a function word slipping through is noise; a content word
  wrongly demoted can never be added). *can · may · will · have · do* are excluded **by
  name**. Don't "complete" it without reading that file's header.

### Cross-cutting
- **Per-sense axis** (JA+EN) — the biggest lever that costs engineering, not money.
- **KO/ZH support** — a new language = its own dictionary source + `<source>_lookup()`.
  Checklist: `docs/Adding_A_Language.md`.

</details>

---

<details open>
<summary><h2>➕ Open follow-ups</h2></summary>

### Custom domain + email deliverability `[launch polish · partly URGENT]`
- **Status:** prod email works but **lands in spam**. Sender is a `@gmail.com` address, and
  `gmail.com` authorizes only Google's servers — SPF/DKIM can **never** align through Brevo.
- **Fix (one task, three payoffs):** register a domain (~$10/yr) → authenticate in Brevo
  (SPF/DKIM/DMARC — zero authenticated domains today) → send from `noreply@<domain>`.
- **Also fixes:** the app URL (`dino-86y.pages.dev`) → then update Supabase Site URL +
  redirects, edge `ALLOWED_ORIGINS`, and Google origins.
- ⚠️ Staging has **no SMTP** — auth emails there go nowhere. Test reset flows locally
  (Inbucket, `:54324`).

### Downstream difficulty-axis reconciliation `[#8 · design call]`
Word difficulty is proficiency-preferred (`override ?? proficiency ?? frequency`), which
makes `users.level` drift toward `users.proficiency_band` (redundant), while #12's domain
filter wants a **dense frequency** axis for bandless words. Pick one: keep `users.level`
explicitly frequency, or go proficiency-preferred everywhere. Decide **before #12 ships**.

### Proficiency label axis — remaining `[#8]`
Pipeline, ingest, projection, resolver, learn and calibration are **DONE + LIVE**.
`WordInfo.tsx` renders `getProficiency()` in **ListRow**, **FlashcardCard** and
**ArticleWordList**. Remaining: the **translate result head** and the **reader hovercard**.

### Account-linking edge cases (email ↔ Google) `[#13]`
**Gates the captcha rollout.** Collision messaging ("this email signs in with Google") ·
claim/merge story · guest-carry decision · verify auto-link live. Cases: `linkIdentity`
needs `security_manual_linking_enabled` · email + later-Google auto-links only if the email
is CONFIRMED · Google-first then email/password has no set-password UI · guest →
sign-in-Google switches uid, so guest words don't carry.

### App Store submission `[iOS release]`
Code is done: Sign in with Apple (needs a Services ID + a .p8-signed secret that **expires
≤6 months**), account deletion, EDRDG attribution, `PrivacyInfo.xcprivacy` (**keep it in
sync with the App Store Connect privacy labels — Apple compares them**), and `/support`.
Remaining is console work — answers prepared in `docs/checklist/App_Store_Submission.md`;
left there: signing + TestFlight, screenshots, the app record, Apple credentials.

- ‼️ **Decide iPhone-only vs iPad first.** The target is `TARGETED_DEVICE_FAMILY = "1,2"`,
  which obliges a **13″ iPad screenshot set** *and* an iPad layout review will test —
  DINO has never been run on one. Setting it to `"1"` removes both from v1.
- Screenshots: **6.9″ iPhone `1320 × 2868`** (Apple scales it to every smaller iPhone). A
  phone screenshot only passes if the phone IS a Pro Max; otherwise capture from the
  Simulator (`xcrun simctl io booted screenshot`). sRGB PNG/JPEG, no alpha.
- ⚠ The native live transcript is **untested on a device**. Also unresolved: whether it
  should keep listening while another app is foreground (needs the `audio` background mode
  and a review justification).

### Legal — Privacy/ToS counsel review `[§10]`
`/privacy` + `/terms` are drafted and footer-linked. Remaining: **counsel review before
going truly public**; bump `CURRENT_TERMS_VERSION` when reviewed copy lands.

### Source-language mismatch robustness `[translate UX]`
A concrete source that mismatches the script (source=JA, Latin input) produces garbage.

### Very low priority
- **Real furigana (#16)** — ruby above kanji.
- **FSRS (#19)** — SRS to D/S/R (power-law), fit to `review_log`. A new `record_review()`
  body, same API. HLR is fine for now.
  - ⚠️ **`20260744` constrains which FSRS you can fit.** `review_log` now keeps one row per
    card per UTC day with a `repeats` counter. That is conventional FSRS-4.5 preprocessing,
    but **FSRS-5's short-term model consumes same-day reviews and those grades are gone.**
    Decide before fitting; reverting only helps data logged *after* the revert.

</details>

---

**To publish (non-code):** Privacy/ToS counsel review + Production Rules console hardening.
Admin tooling · Quality ceilings · Features are post-launch.

**🧪 Pre-publish QA gate:** re-run the multi-agent pre-publish review before any published
build / after any major change.

---

<details>
<summary><h2>📋 Production Rules — standing checklist (live prod console)</h2></summary>

Not a to-do — standing rules + hosted toggles. Numbers preserved from `Production_Hardening.md`.

**5. Forward-only migrations** `[§11]` — never edit an applied migration. Process, not a task.

**6. Automated backups + PITR** `[§2]` — needs **Pro**. Tooling is done; interim is running
`npm run db:backup` manually.

**7. Observability — alerting** `[§9]` — point edge structured logs at hosted alerting
(spend, 5xx, uptime). Emitted today: `mt_spend` · `request` · `global_cap_reached`. There is
**no `health` event** — `/health` falls through the generic `request` line.

**8. Confirm pg_cron jobs registered on prod/staging** — the guest sweep (`20260727`) and
`idempotency_keys` prune (`20260712`). Both silently no-op without pg_cron; `dry_run` first.

</details>

<details>
<summary><h2>⏳ Awaiting merge</h2></summary>

| PR | What | Note |
|----|------|------|
| **#30** | CORS default-to-deny · error-`kind` rendering · recognizer memoization | LOW security cluster. CORS still defaults to `*` in `index.ts`. Confirmed still open 2026-08-09. |

</details>

<details>
<summary><h2>🛠 Admin tooling</h2></summary>

**Shipped:** `AdminPage.tsx` gated by `is_admin` — Usage · API health · Grants · Errors · DB
size · Quality reports (with `source` + the reported sense since `20260757`).

**Email send tracker — the one paid-ish service with no meter** `[detect: over-traffic + silent failure]`
- **Nothing is tracked, on either side.** `/support` is a static page showing an address —
  no form, so a support request never touches our backend. Auth mail goes GoTrue → Brevo
  SMTP, which we never see: `requestPasswordReset` resolves **identically** whether Brevo
  delivered or rejected it. `provider_status`'s `brevo` row is hand-typed free text.
- **Why it bites:** Brevo free is **300 sends/day** (confirmed via `/v3/account`) and the
  auth rate limit was raised 2→30/hr. A burst — or a bot hammering reset-for-email —
  exhausts the day, after which **resets and confirmations simply stop** while the app
  reports success to everyone.
- ‼️ **It has already happened, and we only found out by asking Brevo's API (2026-08-07).**
  Last 30 days: **5 requests · 1 delivered · 4 error** — all four *"the sender you used …
  is not valid"*, on 2026-07-13, fixed the same session. Not an open outage; the point is
  that four auth emails failed and **no surface in the app knew** for three weeks.
- **Build, in order:** (1) poll `/v3/account` + `/v3/smtp/statistics/aggregatedReport` on a
  schedule into `email_usage (day, requests, delivered, errors, bounces, credits_left)` —
  `BREVO_API_KEY` is already in `.env.deploy`; (2) log each reset/confirmation trigger
  app-side and fold it into the Auth audit below — the **gap** between "we asked for N" and
  "Brevo reports M" is the silent-failure signal, and neither number alone shows it;
  (3) thresholds on the admin dashboard, not paging infra.
- **Support requests are separate and unbuilt** — measuring them needs `/support` to become
  a form → edge function → table. A product decision, not instrumentation.

**Edit `words` cache — re-projection sweep (#3)**
- **Correctness is SOLVED** (#34): stale rows are a cache MISS and re-project in place.
- **Left — storage:** rows the current projection no longer emits are never served but still
  occupy the tier. **Left — destructive merge/repoint:** gated on a test harness.

**Translation / MT call log** — per request: input length · path (JMdict·WordNet·MT) · cache
hit/miss · est. cost · latency. Persist the edge's `mt_spend` stream so spend and provider
mix are queryable.

**Quota / limit-hit events** — log every 413 (`paragraphCharLimit`) and 429
(`monthlyCharQuota` · `GLOBAL_MONTHLY_CHAR_QUOTA` · `MT_DISABLED`) with cap + user.

**Auth / account audit** — append-only: sign-up · upgrade · sign-in/out · reset. Who and
when, never passwords. Deletion is already covered by `account_deletion_log`.

**Admin-action audit** — partial (`feature_grants.granted_by`, `provider_status.updated_by`).
Missing: a real audit table (action · target · admin · time). The surface must audit itself,
since grants are never revoked.

**Content-safety blocks** — `services/contentSafety.ts` filters but records nothing. Log
`isExplicitSuggestion` hits to monitor false positives and abuse.

**Edge health / latency** — surface p50/p95, status mix, 5xx. The in-app half of Production
Rules #7.

**Log retention + privacy** — admin-only read is done. Left: a retention window for
`error_log` (raw input, 500-char truncated → PII). ⚠️ **Not a drop-in:** `20260706` REVOKEs
DELETE/TRUNCATE even from `service_role`, so retention needs a migration re-granting DELETE
— trading against the append-only guarantee. Decide which wins.

**API health: auto-pull real usage** — Google MT chars are already live from
`global_translation_usage`. Still manual: Brevo send count (specified under **Email send
tracker** — do it there), Google quota, Supabase billing caps.

</details>
