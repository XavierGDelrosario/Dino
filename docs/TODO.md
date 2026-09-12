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

- Rule: **free on-device on native (#18); paid/heavy on web.** See CLAUDE.md `#18`.
- Core (`analyze()` → `services/` → account) is identical across surfaces; only intake differs.

### 📱 App

#### AI agents — generative study aids
- **Cost:** `ANTHROPIC_API_KEY` secret + generations/month quota
- **Feature:** domain paragraph quiz ("paragraph at level X from these seeds").

### 🧩 Extension — browser capture surface `[new surface · extends #9/#18]`

**What the extension can do that the app cannot** — reach text on the open web *in the
user's own session*: articles behind a login, X/TikTok/IG captions, YouTube transcripts.
Server-side fetching of those is ToS-blocked; in-session extraction is not.

| | Extension | App (native) |
|---|---|---|
| Text on the open web | ✅ the whole point | user-paste only |
| Spoken layer of video | ✗ | ✅ STT |

- **Two modes.**
  - **Mode A** highlight → add-to-list bar; hover →
  senses + **your `✓ n/5` confidence**
  - **Mode B** full scan → Chrome Side Panel: stats + deduped list + coloured reader quiz-new; robust on SPAs because the text is lifted into our surface.
- **Adapter tiers:**
  - T0 selection (any page, no per-site code)
  - T1 Readability (articles)
  - T2 per-site (YouTube/X/TikTok — social DOMs churn, real upkeep, user-initiated only).

- **Reading order (2D→1D):** DOM order ≈ reading order until CSS grid/absolute or
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
| **Wikipedia** | MediaWiki API | **CC BY-SA → re-host OK** | **App** |
| **Wikinews** | MediaWiki API | **CC BY → re-host OK** | **App** |
| **VOA Learning English** | RSS / scrape | **PD → re-host OK** | **App** |
| Global Voices | RSS | **CC BY 3.0 → re-host OK** | **App** |
| **Aozora / Gutenberg** | bulk DL | **PD → re-host OK** | **App** |
| **YouTube** | embed; captions in-session / CC-BY / paste | derived; **ToS: no server scrape** | **Lim App** |
| **X · TikTok · Instagram** | T2 adapter / selection | derived, in-session; ToS hostile | **Lim App** |
| Generic page | T0 selection / T1 Readability | derived, in-session or Art 30-4 | **Lim App** (App if pasted) |
| **NHK** (news / Easy) | RSS → link-out; ext in-session; paste | Art 30-4 derived, **no re-host** | **Lim App** |
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

### Articles (inside Learn) — deep analysis for longer works
- Extension content

### Sense enrichment — example sentence + source-language definition per meaning
- **Built:** `sense_curation` (migrations 20260750–52, keyed on `dictionary_ref` + language
  pair) ← `npm run validate:sense-examples` (the kuromoji gate) → `npm run
  ingest:sense-examples` (deletes + reloads the pair from the file, then backfills cached
  `words` — a saved word is read straight off `words`, so skipping it starves exactly the
  words a user studies). Shows in the reader hover card, the flashcard back, Lists, and the
  article word list.
- **What's left is the CORPUS.** `data/sense_examples/ja.tsv` = **1,030 senses / 611 entries**.
  Senses by headword frequency ≥500 = 4,534 · ≥400 = 16,880 · all 251,734 (~280 B/row
  measured on prod ⇒ ≈1.3 MB · ≈5 MB · ≈70 MB).
- **No coverage query** — batches are picked by hand. A script listing the highest-frequency
  senses missing from the tsv would pick them from data instead.
- **EN→JA (`en.tsv`) not started.** The ingest already scopes its DELETE per language pair.
- **Authoring rules** (long form in the tsv header): demonstrate THAT sense · natural JA in
  the word's register · short enough for a hover card · definitions as a monolingual
  dictionary writes them, carrying the collocation/negation habits a gloss cannot (遜色
  glossed "inferiority" invites the unnatural 遜色がある; the definition says 多くは「ない」を伴って使う).
  - ⚠️ **No difficulty ceiling on supporting vocabulary.**「この部屋は書斎と客間を兼ねている」 is the natural
    sentence even though 書斎/客間 aren't easier than 兼ねる. **The rabbit hole is the feature.**
    Do not re-impose.
- **The definitions are AUTHORED, not sourced.** JMdict glosses are target-language only;
  WordNet's non-English `synset_def` rows (`ingest-wordnet.ts` filters `d.lang = 'eng'`) read
  like translated English and cover only synset-linked words — verify coverage before
  treating it as a shortcut.

### Camera / OCR — photo → text
- **Built:** Mode A on iOS (Apple Vision via `TextOcrPlugin.swift`, per-line boxes), camera
  **and** photo-library sources, crop-before-recognize, reading-order assembly.
- **Web:** nothing free — Cloud Vision is $1.50/1k (1k/mo free). Needs `user_limits`.
- **Vertical (縦書き)** is unhandled
- **Mode B (AR overlay):** tappable chips per box, then replace-in-place. The geometry already flows from `captureResult()`.

### Voice — live listener language handling `[design call]`
- **Built:** the live transcript
  - **The "native" side is GUESSED** — `SUPPORTED_LANGUAGES.find(l => l.code !== learning)`
    is positional, right for JA↔EN only by list order. `useTranslate` resolves it properly;
    thread that through. **Do before a third language ships.**
  - **No language control inside the transcript** — it follows the Translate tab.
  - **One language per session.** A bilingual conversation (the actual case in Japan) is
    recognized entirely as the learning language. On-device recognizers do no language
    identification, so the honest options are a manual toggle or accepting it.

### Handwriting — "draw the character" `[iOS first]`
- **Built:** `HandwritingCanvas` + `services/handwriting`; recognized text appends into the
  input and flows through the existing `analyze()` → JMdict pipeline.
- **iOS:** ML Kit Digital Ink — on-device, free, ~20 MB model, wifi-once.
- **Web:**`inputtools.google.com` (ToS-gray) or rasterize → Cloud Vision. Stroke capture is trivial; recognition is the whole problem.

</details>

---

<details open>
<summary><h2>🐞 Bugs · scalability · hardening</h2></summary>

### EN→JA lookup `[largely addressed — 20260765]`
- **Re-measured on prod 2026-08-13 and the old numbers no longer hold.** The entry read
  "5.0 s for one, 4.3 s back, 2.9 s own" (2026-08-07); today those are **404 / 143 / 134 ms**.
  Something between the two fixed the pathological case; nobody re-measured.
- **`20260765` capped the candidate fan-out.** The cost was never mostly the gloss scan —
  for "one" that is 141 ms of 519 ms (27%), the rest being the LATERAL headword resolution
  running once per candidate entry, **7,693 times to return 12 rows**. The sort's first two
  keys are computable from the scan alone, so they define tiers that dominate it; once the
  top tiers hold 12 entries the rest cannot place. **"one" 404 → 191 ms (2.1×); 10 of 24
  sampled words ≥1.5×; none slower.** A word with a thin top tier ("own": 7) keeps every
  candidate and pays what it always did.
- ⚠️ **The `gloss_terms` index this entry used to prescribe was built and REJECTED.** Both
  shapes, on prod, inside a rolled-back transaction: materialised
  `gloss_terms(term, entry_id, rank)` = 1,087,028 rows ≈ **85 MB**; `GIN(to_tsvector
  ('simple', text))` = **10 MB** and measured **0.6–1.2×** over a median of 7 — noise, some
  slower, because it addresses the 27%. Don't rebuild it. (85 MB would also have taken half
  the free tier's remaining headroom — the word-map was deleted at 80 MB for that reason.)
- **Still open, if it ever matters again:** a thin top tier plus a large T2 (`own`: 7 + 451)
  prunes nothing. Ordering inside T2 needs `pref.frequency`, so it would need a cheap
  per-entry frequency to pre-rank on — a materialised column, i.e. storage again.
- **Already routed around** where it was fatal: the learn/placement path skips the gloss
  fallback entirely (`skipGlossFallback`), because the EN pool only emits surfaces WordNet
  can translate. That fixed A1/A2 placement timing out.

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

- **Per-(kanji, reading) frequency.** wordfreq is per-surface. Curated `readingOverrides.ts` is the only lever.

  - A blanket curated list is **ruled out** (~4,169 ambiguous frequent words). Extend by hand only.
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
**Root cause of most gaps below:** `analyze()` gives English a POS (`posEn.ts`) but still no
READING and only a partial lemma — everything non-JA routes to `segmentOnly` for the rest.
It only bites when English is the **learning target**.

| Gap | Blocked on | Note |
|---|---|---|
| Modal/noun homographs | training data | The one thing the tagger does **not** do. UD English-EWT has `can` 583× — **578 AUX vs 5 NOUN** — so both the tag dictionary and the model correctly learn it is always an auxiliary. A different model won't fix it; only a corpus carrying the noun sense will. Pinned in `posEn.test.ts` so it isn't re-filed as a bug. |
| Proper-noun recall | — | The tagger catches **85.5%** of names (precision 84.8%), so ~1 in 7 still reaches paid MT. Retraining on a news-weighted corpus is the lever — EWT is web text (reviews, forums), and the Media corpus is newswire. |
| Reader-side lemma | — | ‼️ **Newly unblocked.** Irregulars (incl. the WordNet long tail via `irregularsEn.generated.ts`), plurals and possessives already resolve. Regular **-ing/-ed/-es** that the exception list does not name were skipped for want of a verifier — a wrong lemma silently resolves the word to something else — and the tagger's VERB/NOUN tag now IS that verifier. *running* → *run* is a `lemmaEn.ts` change gated on the token's tag. |
| Band coverage | — | **27.7% stored** (7,791 of 28,144 common single-word WordNet lemmas; "common" = wordfreq ≥ 250, the `EMBED_FREQ_FLOOR` — that floor is what reproduces the figure), but **37.3% effective**: lemmatization reaches a band for 2,716 more. The number that matters is on real text — **54.7% → 65.4%** of en.wikinews content tokens carry a band before vs after `englishLemma` (119 articles, 21,847 content tokens, re-measured 2026-08-13). ⚠️ **Do not price a bigger list off the raw gap.** Of the 20,353 unbanded: 2,716 lemma-reachable · 3,567 have no JA translation so cannot be studied anyway · 2,936 proper nouns (capitalised in every WordNet sense) · ~105 digits and single letters. The 11,029 left are still visibly names-as-common-nouns (*john · china · trump · google · jack*), slang (*shit · kinda · porn*) and abbreviations (*info · tech · semi · iii*). The genuine miss is a mid-frequency tail — *according · fourth · supreme · attorney · ministry · infrastructure · enforcement · protein*. **Re-measure with the tagger demoting names before buying anything**; the cheap band win is per-POS bands (next row), which needs no purchase. |
| Per-POS bands | — | CEFR-J ships `headword,pos,CEFR`; `build-proficiency-cefr.py` keeps headword+CEFR only and collapses to the easiest band. Keeping `pos` gives per-POS bands (PK → `(surface, pos)`) — the cheap English down-payment on the per-sense axis. |
| Sense disambiguation in context | — | ‼️ **Newly unblocked.** **75%** of banded EN lemmas are polysemous (mean 4.21 synsets, max 75). Lesk over `definition_en` + the reader's sentence needs no new data, and the tagger's tag now narrows the synset set by POS before Lesk runs. |
| Derived-form band | per-POS bands | `growing` takes the list's B2 rather than inheriting `grow`'s A1 plus a penalty. Pool ORDERING is handled (`20260761`); placement is not. |
| Compound handling | — | JA has `compounds.ts`; EN has nothing (*bus stop* → two words). Marginal. |
| EN→JA sense quality | — | WordNet synsets lead, gloss fills; grouping never live-verified (spring 春/泉/ばね). ⚠️ `wordnet_senses_en.sense_rank` is **0 on all 206,941 rows** — wnjpn ships no ranks — so the intra-tier tiebreak `20260747` reserves for WordNet's own sense order is INERT. `headline_rank` carries the ordering alone (measured 28/30 top-1). Princeton `index.sense` tag counts would fill it; ids line up (`07125096-n` = offset+POS), so bundle it into any `wordnet_*` re-ingest rather than doing it alone. |

**Not gaps — do not file these.** Furigana, the reading/writing override tables, context
sense ordering (`senseOrder`) and potential-verb/する candidates all key on a **reading**,
which English does not have; sense examples + JA definitions are JA→EN by design.
- **Written pronunciation (IPA/stress) — deferred, `services/voice` already speaks the
  word.** Costing and the `input_reading` cache-key trap live in `QualityLimitations.md` §2.
- **EN POS offsets in the leveling profile — measured, rejected.** Each class overstates
  its band by adjective **+7** · noun **+3** · verb **−9** · adverb **−11** (Zipf×100, over
  8,316 banded CEFR words) vs Japanese affix **+58** / verb **−75**. ~6× smaller, inside
  the noise of a signal whose R² is 0.24, and structural — frequency is per-SURFACE, and a
  JA verb splits across dozens of conjugations where an EN one splits across three, so more
  data won't move it. Only the safe direction applies, leaving +7/+3. English stays
  band-led **by evidence**; numbers are in `build-leveling-profile.ts`.

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

### Difficulty axis — is `users.level` redundant? `[#8 · cleanup]`
Word difficulty is proficiency-preferred (`override ?? proficiency ?? frequency`), so
`users.level` drifts toward `users.proficiency_band`. No longer a fork: the only thing that
wanted a separate **dense frequency** axis was #12's domain filter, which is dropped. Now a
redundancy cleanup — check `users.level`'s consumers before removing it.
- ⚠️ **Keep the frequency ARM of `getDifficulty` regardless.** Only 27.7% of common English
  lemmas are banded, so ~7 in 10 English words reach a level through frequency alone.
- ⚠️ **Two runtimes compute "how hard is this word"** — client `getDifficulty` and SQL
  `srs_leveling` (`20260731`), which reads `words` directly and never calls the client. Same
  axis, no shared test pinning them (cf. `display_confidence` ↔ `services/confidence.ts`).

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

- **iPhone-only for v1** — `TARGETED_DEVICE_FAMILY = 1`, so no iPad screenshot set and no
  iPad layout in review. Don't widen it back before launch: adding iPad later is a normal
  update, removing a device family after release is not.
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
- **FSRS (#19)** — a fitted D/S/R scheduler. A new `record_review()` body, same API.
  **Blocked on DATA, not engineering** — revisit at ~1,000+ reviews for a real user.
  - **Why it's still open:** every constant in `record_review` is hand-tuned and has never
    been checked against whether anyone actually recalls — the seeds (1.5/4/10/22/40),
    the growth (1.0/2.0/3.5), the lapse caps, `c_fresh_r`, the freeze grace. Fitting is
    also the only way to settle whether frequency or the curated band predicts recall
    (measured **R² = 0.24**, so today's ease rests on a weak signal). `review_log` has
    carried `ease · word_position · user_position · level_source · retrievability` since
    `20260731` precisely to make that fit possible.
  - **Smaller than it sounds now.** Much of what FSRS buys already landed piecemeal: a
    difficulty-like axis (`20260731` ease), fuzz + lapse cap + cram freeze (`20260729`),
    display separated from schedule (`20260735`). The real remaining deltas are a
    **per-card fitted difficulty** (today's ease comes from the level gap, not from that
    card's history) and the **power-law curve** `R = (1 + Δ/9S)^-0.5`, which only diverges
    from `exp(-Δ/S)` at long intervals.
  - ‼️ **FSRS-5 is already foreclosed — this is not a decision you still get to make.**
    `20260744` keeps one row per card per UTC day with a `repeats` counter. That's
    standard FSRS-4.5 preprocessing, but FSRS-5's short-term model consumes same-day
    grades and **those are gone, irreversibly**: reverting only helps data logged after
    the revert. **FSRS-4.5 is the only version fittable to existing history.**
  - Until then HLR is fine, and "fine" is load-bearing — it is not a placeholder anyone
    needs to rush.

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
