# DINO — TODO (Launch + Roadmap)

Remaining work only. Shipped → git history, `tests/`, `docs/`.
Tags: `[concern]` raised directly · `[#N]` roadmap · `[§N]` `Production_Hardening.md`.
Order **topical, not priority** — priority is in each note.


---

## Features to add

<details open>
<summary>Show</summary>

- Rule: **free on-device on native (#18); paid/heavy on web.** See CLAUDE.md `#18`.
- Core (`analyze()` → `services/` → account) is identical across surfaces; only intake differs.

###  App

#### AI agents — generative study aids
- **Cost:** `ANTHROPIC_API_KEY` secret + generations/month quota
- **Feature:** domain paragraph quiz ("paragraph at level X from these seeds").

#### Lessons — authored grammar explanations `[new Learn section]`
- **Content in the DB, not the bundle** — `lessons` (slug + lang pair + `blocks` JSONB +
  `published_at`; client SELECT on published only, no client write, like `words`) +
  `lesson_progress` (own-rows). A new lesson is an ingest, **not an app release** — the point
  on iOS, where a content change otherwise costs a review cycle. Add `lesson_progress` to the
  three enumerations: `prune_anonymous_guests` emptiness, `backup-user-data.sh`,
  `delete_account` cascade.
- **Authoring:** one Markdown file per lesson (frontmatter + `:::` directives) in git →
  `validate:lessons` (kuromoji gate · every `wordRef` resolves · every answer index in range)
  → `ingest:lessons`. Same shape as `sense_examples`.
- **Blocks — closed union.** `prose` · `pattern` · `example` · `cloze` first; `table` ·
  `choice` · `vocabquiz` once authoring has been felt. A new lesson is a row; only a new
  block KIND is code.
- **Examples render through `ParagraphReader`, never plain.** `useSenseExampleReader` already
  takes an N-length `texts` array and batches ONE lookup — that is the renderer's engine.
-  **An embedded check is a THIRD quiz type** — cloze/choice over a PATTERN, not a sense.
  CLAUDE.md Terminology says there are exactly two; update it rather than leaving "the quiz"
  ambiguous.
-  **Checks must NOT write `review_log`** — append-only, un-backfillable, the FSRS training
  seed. Grammar-point SRS is its own table.
- **Content cost:** authored per LANGUAGE PAIR (the explanation is in the native language),
  so JA-in-EN and JA-in-JA are separate lessons.
- **Prerequisite — Learn section registry.** `LearnView` hardcodes picker → bands → Articles,
  and `onArticleOpen` is a one-off "this section claims the tab". Replace with
  `services/learn/sections.ts` (`{ id, title, available(ctx), Component }` + an `onTakeover`
  prop), mirroring the `language`/`difficulty`/`senses` registries. Stands alone.

###  Extension — browser capture surface `[new surface · extends #9/#18]`

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

### ⚙️ MT cost at scale — sentence cache + provider cascade `[cost · low]`

**Low priority:** past the cap iOS falls back to free on-device ML Kit glosses, so this only
pays off once **web** gloss volume is real. Media multiplies **sentence-gloss** calls
(word-by-word is free from the JMdict cache). Fix VOLUME first, then price.

- **Lever 1 — shared `sentence_cache`**, key `hash(normalized_text, source, target)`.
  Inverts `persist:false`: a unique paste isn't worth caching, but shared media across
  users has a high hit rate. Plus lazy on-demand gloss and within-doc dedupe.
- **Cascade:** `sentence_cache → DeepL (free ~500k/mo) → Google` **[edge]** → Apple
  **[native only, offline last resort]**.  Apple is not a server step — the edge cannot
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
-  **A bulk backfill must NOT go through the edge** — 2.92M chars would blow the 2M/mo
  `GLOBAL_MONTHLY_CHAR_QUOTA` and 429 every real user mid-run. It would be an offline
  service-role script calling Google direct.
- **Legal (Wikinews):** CC BY 2.5 → storing prose and serving a derivative translation are
  both fine with attribution + link-back (already rendered by `ArticleView`).

</details>

---

## 🧱 Extendable Features

<details open>
<summary>Show</summary>

### Streak · goals · reminders (`/goals`, migrations 20260790–92)
- **Web reminders fire only while a tab is open** (Notification API + timer). Always-on web
  = a service worker + push; the iOS build already gets real scheduled notifications.
- A cram-frozen same-UTC-day re-grade leaves no trace in `study_days` (no log row, no
  `last_reviewed_date` move) — a JST morning of only well-known cards can read unstudied.
- Guest→account merge does not carry the goal columns (account's choice stands) — revisit if
  users notice.
- Streak freeze / repair, weekly goals, goal-met celebration — none built.

### Articles (inside Learn) — deep analysis for longer works
- Extension content

### Sense enrichment — example sentence + source-language definition per meaning
- **What's left is the CORPUS.** `data/sense_examples/ja.tsv` = **2,368 senses / 1,660 entries**.
  Senses by headword frequency ≥500 = 4,534 · ≥400 = 16,880 · all 251,734 (~280 B/row
  measured on prod ⇒ ≈1.3 MB · ≈5 MB · ≈70 MB).
- **No coverage query** — batches are picked by hand. A script listing the highest-frequency
  senses missing from the tsv would pick them from data instead.
- **Authoring rules** (long form in the tsv header): demonstrate THAT sense · natural JA in
  the word's register · short enough for a hover card · definitions as a monolingual
  dictionary writes them, carrying the collocation/negation habits a gloss cannot (遜色
  glossed "inferiority" invites the unnatural 遜色がある; the definition says 多くは「ない」を伴って使う).
  -  **No difficulty ceiling on supporting vocabulary.**「この部屋は書斎と客間を兼ねている」 is the natural
    sentence even though 書斎/客間 aren't easier than 兼ねる. **The rabbit hole is the feature.**
    Do not re-impose.
- **The definitions are AUTHORED, not sourced.** JMdict glosses are target-language only;
  WordNet's non-English `synset_def` rows (`ingest-wordnet.ts` filters `d.lang = 'eng'`) read
  like translated English and cover only synset-linked words — verify coverage before
  treating it as a shortcut.

### Camera / OCR — photo → text
- In photo show translations



</details>

---

##  Bugs · scalability · hardening

<details open>
<summary>Show</summary>

### EN→JA lookup speed (English word → Japanese results) `[low · 20260765]`
- ⚠️ **The `gloss_terms` index this entry used to prescribe was built and REJECTED.** Both
  shapes, on prod, inside a rolled-back transaction: materialised
  `gloss_terms(term, entry_id, rank)` = 1,087,028 rows ≈ **85 MB**; `GIN(to_tsvector
  ('simple', text))` = **10 MB** and measured **0.6–1.2×** over a median of 7 — noise, some
  slower, because it targets the gloss scan — only 27% of the cost (the rest is per-candidate
  headword resolution). Don't rebuild it. (85 MB would also have taken half
  the free tier's remaining headroom — the word-map was deleted at 80 MB for that reason.)
- **Open, if it ever matters:** a thin top tier plus a large T2 (`own`: 7 + 451)
  prunes nothing. Ordering inside T2 needs `pref.frequency`, so it would need a cheap
  per-entry frequency to pre-rank on — a materialised column, i.e. storage again.

### Test coverage
- **Edge error-log e2e** — the sink contract is covered; driving a real failing edge path
  isn't (not deterministically forceable over HTTP).
- **Native simulator smoke** (XCUITest/Appium) — the only layer that would exercise
  `functions.invoke` + real CORS *together*. The CapacitorHttp regression that hung
  `invoke` had no test. Until justified: a manual device checklist.

### Security (2026-06-28 audit)
- **[MED] Enable captcha in prod** 
- **[MED · scale-only] Global-quota advisory lock** — contention only bites at huge MT
  throughput; shard by hash bucket if it does.

</details>

---

## ➕ Open follow-ups

<details open>
<summary>Show</summary>

### App Store submission `[iOS release]`
Console work only. ⚠️ Sign in with Apple's .p8-signed secret **expires ≤6 months**;
keep `PrivacyInfo.xcprivacy` **in sync with the App Store Connect privacy labels**. Answers
are prepared in `docs/checklist/App_Store_Submission.md`; left there: signing + TestFlight,
screenshots, the app record, Apple credentials.

- **Build blocker:** uploads need **Xcode 26 / iOS 26 SDK** (since 2026-04-28). The dev
  Mac (2014 MBP, OCLP) stays on Sonoma + Xcode 16.2 for device installs — **no Sequoia
  upgrade; archive in Xcode Cloud** (decided 2026-11-03). Needs the paid membership.
  Left: `ci_scripts/ci_post_clone.sh` (Node + CocoaPods, `npm install`, prod web build,
  `cap sync` — Pods + web bundle are gitignored) · `build-ios.sh` reads Xcode Cloud env
  vars instead of the absent `.env.deploy` · final checks on the TestFlight build.
- **Enroll as Individual** ($99/yr)
  (those are nonprofit/edu/gov only).
- **Free, no IAP → Free Apps agreement only**
- **EU DSA trader status** is asked before EU distribution: free + pre-revenue 

- Screenshots: **6.9″ iPhone `1320 × 2868`** Skip ipad for now

### Legal — Privacy/ToS `[§10]`
**Counsel review is NOT a launch gate** while DINO is free, pre-revenue and founder-run
(decided 2026-09-29) — pay for counsel at a trigger. Governing law is **British Columbia**;
keep the Apple enrollment country and the operator address consistent with it.
- **Counsel triggers:** first revenue (IAP / subscription / paid tier — also needs a
  特定商取引法 disclosure page) · incorporating · ads or any tracking SDK · marketing to
  the EU · ~1k active users.

### Very low priority
- **Real furigana (#16)** — ruby above kanji.
- **FSRS (#19)** — a fitted D/S/R scheduler. A new `record_review()` body, same API.

</details>

---

**To publish (non-code):** Production Rules console hardening. Counsel review waits for a trigger (see Legal).
Admin tooling · Quality ceilings · Features are post-launch.

---

## 📋 Production Rules — standing checklist (live prod console)

<details>
<summary>Show</summary>

Not a to-do — hosted toggles the founder flips. (Process rules the assistant follows — forward-only migrations, the pre-publish QA gate — live in CLAUDE.md → Standing process rules.) Numbers preserved from `Production_Hardening.md`.

**6. Automated backups + PITR** `[§2]` — needs **Pro**. Tooling is done; interim is running
`npm run db:backup` manually.

**7. Observability — alerting** `[§9]` — point edge structured logs at hosted alerting
(spend, 5xx, uptime). Emitted today: `mt_spend` · `request` · `global_cap_reached`. There is
**no `health` event** — `/health` falls through the generic `request` line.


</details>

## 🛠 Admin tooling

<details>
<summary>Show</summary>

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
- **Left — storage:** rows the current projection no longer emits are never served but still
  occupy the tier. **Left — destructive merge/repoint:** gated on a test harness.

**Auth / account audit** — append-only: sign-up · upgrade · sign-in/out · reset. Who and
when, never passwords. Deletion is already covered by `account_deletion_log`.

**Admin-action audit** — partial (`feature_grants.granted_by`, `provider_status.updated_by`).
Missing: a real audit table (action · target · admin · time). The surface must audit itself,
since grants are never revoked.

**Content-safety blocks** — `services/contentSafety.ts` filters but records nothing. Log
`isExplicitSuggestion` hits to monitor false positives and abuse.

**Edge health / latency** — surface p50/p95, status mix, 5xx. The in-app half of Production
Rules #7.

**Log retention + privacy** — a retention window for
`error_log` (raw input, 500-char truncated → PII). ⚠️ **Not a drop-in:** `20260706` REVOKEs
DELETE/TRUNCATE even from `service_role`, so retention needs a migration re-granting DELETE
— trading against the append-only guarantee. Decide which wins.

**API health: auto-pull real usage** — still manual: Brevo send count (specified under **Email send
tracker** — do it there), Supabase billing caps.

**Low priority — MT usage.** Hitting a cap degrades gracefully: past the allowance the iOS
app glosses sentences with free on-device ML Kit (`services/translation/onDevice.ts`), and
word lookups stay free via JMdict everywhere. Only the **web** loses sentence glosses at the
cap, so this matters only if web traffic grows.
- **Translation / MT call log** — per request: input length · path (JMdict·WordNet·MT) ·
  cache hit/miss · est. cost · latency; persist the edge's `mt_spend` stream.
- **Quota / limit-hit events** — log every 413 (`paragraphCharLimit`) and 429
  (`monthlyCharQuota` · `GLOBAL_MONTHLY_CHAR_QUOTA` · `MT_DISABLED`) with cap + user.
- **Auto-pull Google MT quota** into API health.

</details>

---

## ✨ Quality ceilings

<details>
<summary>Show</summary>

Where OUTPUT quality is **capped** — ceilings, not bugs. Each: what's lacking → the miss.
⬛ = omitted for storage. Full ledger: `docs/QualityLimitations.md`.

### 🇯🇵 Japanese

- **Per-(kanji, reading) frequency.** wordfreq is per-surface. Curated `readingOverrides.ts` is the only lever.

  - A blanket curated list is **ruled out** (~4,169 ambiguous frequent words). Extend by hand only.
  - Long-term UX for single-kanji lookups is **multi-reading display** (top 2–3), not one
    guess. In-sentence is already fine — kuromoji has context.
- **Per-sense granularity** — frequency is per-surface, proficiency per-entry and
  reading-matched (`20260740`, `apply:proficiency`), never per-sense. A homograph gets one blended band/frequency. Unlock is
  engineering, not money. **The biggest lever on this list.**
- **JLPT list coverage** — **1,656 of 6,604** JA rows carry no band (down from 3,100 after
  `20260740`). Those entries are absent from the Waller list, and every free JLPT list
  traces back to it. Unlock: a licensed independent list.
- **Furigana** — group ruby only; per-kanji alignment (`alignFurigana`) deferred.
- **kuromoji readings in sentences** — best-effort, mis-reads short fragments. Paragraph
  furigana is a hint; `words` readings are the source of truth.
- **Ease-curve calibration** — JA POS offsets and anchors are tuned to JLPT as a proxy, not
  fit to real `review_log` volume.

### Cross-cutting
- **Per-sense axis** (JA+EN) — the biggest lever that costs engineering, not money.
- **KO/ZH support** — a new language = its own dictionary source + `<source>_lookup()`.
  Checklist: `docs/Adding_A_Language.md`.
- **Language pair assumes exactly TWO languages** — must change before a third ships.
  The learning language defaults to "the other one" than native (`otherLanguage`,
  `defaultLanguagePair`, `resolveLanguagePair` in `services/language/registry.ts`), and
  Translate / Add word drop their dropdowns while `FIXED_LANGUAGE_PAIR` holds. With three there is no "other one": new users need a
  real choice of what to learn (an onboarding step or a picker), and every
  `otherLanguage` caller needs revisiting.

</details>

---

## 🇬🇧 English learning — paused

<details>
<summary>Show</summary>

**Paused 2026-11-07: Japanese is the only learning language** (registry `learnable` flag —
re-offering English is flipping it back on). English stays a native + lookup language, so
EN→JA lookup work above is NOT here. Parked until English learning returns:

### Content
- **Sense examples EN→JA (`data/sense_examples/en.tsv`)** — not started; the ingest already
  scopes its DELETE per language pair.
- **VOA Learning English** — RSS / scrape · PD → re-host OK · App surface.

### Stored data + notes (inert while paused)
- `english_frequency` (321k rows) + `english_proficiency` (8,845) on prod; the edge still
  stamps them on new EN→JA rows (2 reads per uncached English word) though no JA learner
  reads them. Rebuildable from `data/frequency/en.tsv` + `data/proficiency/en.tsv` — drop
  them only if the free tier gets tight.
- The Learn/placement EN pool skips the gloss fallback (`skipGlossFallback`) — that's what
  fixed A1/A2 placement timing out.

### Quality ceilings

The core (words/user_words/lists/SRS/quiz) is language-agnostic and identical both ways.
**Root cause of most gaps below:** `analyze()` gives English a POS (`posEn.ts`) but still no
READING and only a partial lemma — everything non-JA routes to `segmentOnly` for the rest.
It only bites when English is the **learning target**.

| Gap | Blocked on | Note |
|---|---|---|
| Modal/noun homographs | training data | The one thing the tagger does **not** do. UD English-EWT has `can` 583× — **578 AUX vs 5 NOUN** — so both the tag dictionary and the model correctly learn it is always an auxiliary. A different model won't fix it; only a corpus carrying the noun sense will. Pinned in `posEn.test.ts` so it isn't re-filed as a bug. |
| Proper-noun recall | — | The tagger catches **85.5%** of names (precision 84.8%), so ~1 in 7 still reaches paid MT. Retraining on a news-weighted corpus is the lever — EWT is web text (reviews, forums), and the Media corpus is newswire. |
| Band coverage | — | **27.7% stored** (7,791 of 28,144 common single-word WordNet lemmas; "common" = wordfreq ≥ 250, the `EMBED_FREQ_FLOOR` — that floor is what reproduces the figure), but **37.3% effective**: lemmatization reaches a band for 2,716 more. The number that matters is on real text — **54.7% → 65.4%** of en.wikinews content tokens carry a band before vs after `englishLemma` (119 articles, 21,847 content tokens, re-measured 2026-08-13). ⚠️ **Do not price a bigger list off the raw gap.** Of the 20,353 unbanded: 2,716 lemma-reachable · 3,567 have no JA translation so cannot be studied anyway · 2,936 proper nouns (capitalised in every WordNet sense) · ~105 digits and single letters. The 11,029 left are still visibly names-as-common-nouns (*john · china · trump · google · jack*), slang (*shit · kinda · porn*) and abbreviations (*info · tech · semi · iii*). The genuine miss is a mid-frequency tail — *according · fourth · supreme · attorney · ministry · infrastructure · enforcement · protein*. **Re-measure with the tagger demoting names before buying anything**; the cheap band win is per-POS bands (next row), which needs no purchase. |
| Per-POS bands | — | CEFR-J ships `headword,pos,CEFR`; `build-proficiency-cefr.py` keeps headword+CEFR only and collapses to the easiest band. Keeping `pos` gives per-POS bands (PK → `(surface, pos)`) — the cheap English down-payment on the per-sense axis. |
| Derived-form band | per-POS bands | `growing` takes the list's B2 rather than inheriting `grow`'s A1 plus a penalty. Pool ORDERING is handled (`20260761`); placement is not. |
| Compound handling | — | JA has `compounds.ts`; EN has nothing (*bus stop* → two words). Marginal. |
| EN→JA sense quality | — | WordNet synsets lead, gloss fills; grouping never live-verified (spring 春/泉/ばね). Sense ranks are filled (`apply:wordnet-ranks`, re-run after any `wordnet_*` re-ingest) and used demote-only past the 5th sense (`20260794`); re-measure the 30-word list before moving that threshold. |

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

- ⚠️ The function-word list **under-reaches on purpose** — surface matching with no POS, and
  the costs are asymmetric (a function word slipping through is noise; a content word
  wrongly demoted can never be added). *can · may · will · have · do* are excluded **by
  name**. Don't "complete" it without reading that file's header.

</details>
