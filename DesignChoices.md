# Design Choices — DINO

A record of the load-bearing engineering forks in this codebase: places where more
than one option was viable, the naive choice was wrong in a non-obvious way, and the
decision came from reasoning about trade-offs rather than reaching for a default.

Each entry is framed as **the fork → what most people would do → what we did and why →
what it demonstrates.** The theme running through all of them: *data-model and identity
decisions are cheap before real users exist and expensive after, so pay the thinking
cost up front.*

---

## 1. Cache identity: a stable dictionary reference, not the headword itself

**The fork.** The `words` table is a lazy cache projected from JMdict. What column(s)
identify a cached row so that re-projecting a sense *updates in place* instead of forking
a duplicate?

**The naive choice.** Key on the natural tuple `(input, translation, source_lang,
target_lang)`. It's the human-readable identity and it's what the `UNIQUE` constraint
started as.

**Why it's wrong (and this was found the hard way).** `input` — the headword — is itself
a *projection output*, not an input. Improving the projection logic (e.g. resolving a
kana search `いく` to its kanji headword `行く`) *changes the value we'd key on*. So a
stale `いく` row, re-pulled, projects to `行く`, whose `ON CONFLICT (input, …)` no longer
matches → Postgres INSERTs a brand-new `行く` row and leaves the stale `いく` as an orphan
duplicate. Worse: `user_words.dictionary_word_id` still points at the stale row, so a
user's saved word silently rots.

**What we did.** Carry JMdict's *stable* identity onto the cache — `jmdict_entry_id`,
`jmdict_sense_pos`, and a direction-aware `dictionary_ref` (`<input>:<entry>`) — and
upsert on `dictionary_ref`. Now re-projecting a sense whose headword changed UPDATEs the
same row (preserving its `word_id`, hence every `user_words` FK) instead of forking. The
legacy natural-key `UNIQUE` was later dropped entirely — it could only cause spurious
collisions and cost write-time index maintenance.

**What it shows.** Recognizing that *an identity key must be stable under the very
transformations you plan to apply to the data.* Keying on a derived field is a subtle,
common bug that only surfaces once you improve the pipeline.

---

## 2. Frequency ranking: verify the data source before building on it

**The fork.** Word difficulty/ranking needs a frequency signal. JMdict is right there and
famously carries priority tags (`nfXX`, `news1`, …). Use them?

**The plan (that got falsified).** The whole difficulty axis was originally designed
around JMdict's `nfXX` priority tags.

**The check.** Before building, verified the actual data: `jmdict-simplified` collapses
*all* priority codes into a single binary `common` boolean — and this is true in **both**
the common subset *and* the full 217k-entry `jmdict-eng` (grepped for `nfXX`/`news1`:
zero hits). The rich ranking the plan assumed simply isn't in the file.

**What we did.** Sourced frequency from **wordfreq** instead — a normalized Zipf score
(×100, cross-language comparable), exported to a TSV and joined onto JMdict surfaces at
ingest time. `jmdict_lookup` orders by the *headword's* frequency (preferred kanji, or
kana for "usually-kana" words — deliberately **not** max-over-readings, which a shared
kana like a common reading would pollute).

**A second fork inside this one.** Why not filter the dictionary *down* to only frequent
words to save space? Rejected: wordfreq's tokenizer can't rank multi-kanji compound nouns
(e.g. 唐揚げ splits into pieces, so it has no whole-word frequency). A frequency filter
would silently drop that entire class of words. So the dictionary stays full; only the
*embeddings/word-map* gets a frequency floor.

**What it shows.** Validating a foundational assumption with a five-minute `grep` before
committing an architecture to it — and understanding a tool's failure mode (tokenizer
can't see compounds) well enough to know where *not* to apply it.

---

## 3. Two axes that must never be conflated: difficulty vs. relatedness

**The fork.** The differentiator feature ("study the media you love" → a quiz tailored to
*that* vocabulary) needs to know both *how hard* a word is and *what domain* it belongs
to. Tempting to treat these as one "closeness" signal from a single embedding space.

**What we did.** Kept them as two orthogonal axes, on purpose:
- **Difficulty = corpus frequency** (a scalar, works for any language with no JLPT-style
  standardized ranking).
- **Relatedness/domain = word embeddings** in `pgvector` (what clusters "volleyball
  terms" together).

**Why.** Embedding *distance does not encode difficulty* — two words can be semantically
adjacent and wildly different in difficulty. Merging them would make both signals wrong.
This distinction is written into the schema: `frequency` is a column on `words`;
embeddings live in a *separate* `word_embeddings` table.

**What it shows.** Resisting a seductive over-unification. Naming two concepts that look
similar and keeping them structurally separate is exactly the judgment that prevents a
class of "why is my recommender ranking easy words as advanced" bugs later.

---

## 4. Translation is backend-only; morphological analysis is client-side

**The fork.** Where does language processing run — browser or server? It's tempting to
pick one answer for "all of it."

**What we did.** Split it by *what gets persisted*:
- **Translation runs only on the server** (an edge function with the service role). The
  browser can never translate on its own, and RLS forbids any client from writing
  `is_verified = true`. Reason: translations are *cached and trusted* — the write
  authority must be a single privileged seam.
- **Morphological analysis (segmentation, readings, lemmas) runs in the browser**
  (kuromoji). Reason: it feeds the *ephemeral, display-only* paragraph reader — nothing
  it produces is ever persisted, so there's no trust boundary to defend, and doing it
  client-side avoids a network round-trip per keystroke.

**What it shows.** Letting the *persistence/trust boundary* — not a blanket "frontend vs
backend" preference — decide where code runs. The line falls exactly where data crosses
from ephemeral to durable.

---

## 5. Reading resolution: authoritative cache vs. context-aware engine

**The fork.** Japanese homographs read differently by context (辛い → からい "spicy" /
つらい "painful"). What produces the furigana — the dictionary's stored reading, or
kuromoji's context-aware guess?

**What we did.** Decide per-surface based on *whether context exists*:
- **No context** (single-word lookup, flashcard): use the **stored `words` reading** —
  authoritative. kuromoji is statistical and unreliable on isolated fragments (in
  isolation it misreads 今 → こん, 行った → 行う).
- **With context** (sentence/paragraph): trust **kuromoji**, because context is exactly
  what disambiguates a homograph. Override it with the dictionary reading *only* when two
  conditions both hold: the surface *is* the dictionary form (so a conjugated 行った keeps
  its surface reading いった, not the lemma's いく), **and** the looked-up senses agree on
  a single reading (so a genuine homograph defers to kuromoji's context).

Crucially, the override reuses the per-token lookup already done for meanings — **no extra
query.**

**What it shows.** Understanding the strengths and failure modes of two data sources well
enough to route each request to the better one, with a precise, conjunction-guarded
override rather than a blunt "dictionary always wins."

---

## 6. Reserve-before-call quota: closing a check-then-meter race

**The fork.** Paid MT calls are metered against a monthly per-user quota. The obvious
shape: read usage → if under quota, call Google → increment usage.

**Why it's wrong.** Two concurrent requests both read a stale "under quota" value, both
pass the check, both call the paid API → overshoot. Classic time-of-check/time-of-use
race, and it costs real money.

**What we did.** An atomic, per-user-advisory-locked **`consume_translation_quota` RPC**
that checks *and* increments in one step, and is called **before** the Google request.
A denied request therefore costs nothing, and concurrent requests can't both slip through.
The month bucket is computed in UTC on both the SQL and edge sides so they never disagree,
and a new month is just a new row (no reset job). The same reserve-before-call shape is
mirrored for the *global* cross-user cap.

**What it shows.** Spotting a concurrency race in a money path and fixing it at the right
layer (a single atomic DB operation), plus the discipline of "reserve before you spend."

---

## 7. "ALL" is a virtual list, not a stored one

**The fork.** Users have a master vocabulary ("ALL") and optional sub-lists. Model ALL as
a real `lists` row that every word auto-joins?

**What we did.** ALL is **not stored**. A user's vocabulary *is* their `user_words` rows;
"every word is in ALL" is therefore a *structural* truth, not an invariant app code has to
maintain. Sub-lists are optional tags via a junction table that references `user_words`,
so a word physically cannot be in a sub-list without being in the vocabulary. Deleting a
word = deleting its `user_words` row (tags cascade). The name "ALL" stays reserved so no
sub-list can shadow it.

**What it shows.** Preferring an invariant that's *impossible to violate by construction*
over one enforced by code that could drift. Fewer moving parts, no "word in a sub-list but
missing from ALL" bug can ever exist.

---

## 8. "Usually-kana" words: reuse two columns instead of adding one

**The fork.** JMdict tags many words `uk` ("usually written in kana") — for these the
*kana* is the headword and the kanji is the secondary form (なる, kanji 成る). That's the
inverse of the normal kanji-headword + kana-furigana layout. Add a column/flag to the
cache to model the inversion?

**What we did.** Reused the existing `input` (headword) and `input_reading` (the other
form shown above it) columns — just populate them in the opposite order for `uk` words. No
new column. And the `uk` decision is made from the **primary (position-0) sense only** —
not "any sense is uk" — because 猫's slangy senses are `uk` while its main "cat" sense
isn't; keying off any sense would wrongly flip 猫 → ねこ.

**What it shows.** Seeing that two columns already mean "headword" and "the other form,"
so the feature is a *population* change, not a *schema* change — and catching the subtle
"which sense decides" edge case that a coarser rule gets wrong.

---

## 9. Getting kuromoji into the browser: two non-obvious, load-bearing fixes

**The fork.** kuromoji is designed for Node. Running it in the browser "mostly works" —
which is the dangerous kind of failure, because it *silently degrades* instead of erroring.

**What we found and fixed.** Two independent issues, both of which fail *silently*:
1. kuromoji's loader calls `path.join`; Vite externalizes Node's `path`, so it silently
   fell back to `Intl.Segmenter` — segmentation with **no lemmas**, so 行った → bare 行.
   Fix: alias `path` to a browser shim.
2. Vite serves `.dat.gz` dictionary files with `Content-Encoding: gzip`, so the browser
   auto-decompresses them, and then kuromoji's *own* gunzip dies with "invalid file
   signature." Fix: a plugin serves `/dict/*.dat.gz` as raw octet-stream with no
   `Content-Encoding`.

Without *both*, Japanese segmentation degrades quietly and inflected/compound words
misresolve. Verified in a headless browser rather than trusted.

**What it shows.** Diagnosing silent degradation (the hardest kind), understanding the
full stack (bundler externalization + HTTP content-encoding + the library's internal
gunzip), and insisting on end-to-end verification.

---

## 10. Language as free-form TEXT and part of every identity key

**The fork.** This is a Japanese-first app today. Model language as an enum (or a FK to a
`languages` table) for safety?

**What we did.** Language is free-form `TEXT` (`source_lang`/`target_lang`) and — the
important part — it's **part of every identity key**: the `words` UNIQUE includes the
pair, and so does the user-words uniqueness. Consequences that fall out for free: adding a
language is *just new rows*; the same surface form across pairs (愛 in JA vs ZH) stays
distinct and never collapses. Non-Latin storage is first-class UTF-8, and the readings
model is two-sided + nullable (kana for JA, pinyin for ZH, NULL for a phonetic side).

The one acknowledged trade-off: free-form TEXT is *unvalidated*, so a `JP`/`JA` typo would
silently fork rows. The chosen tightening (a `languages` registry + FK) is deliberately
deferred to when the second language ships for real — because that's when the FE registry
and the DB actually need to agree.

**What it shows.** Building multi-language readiness *into the identity model from day one*
(the expensive-to-change part) while consciously deferring the cheap-to-add validation
(the easy-to-change part) — and being explicit about the trade-off rather than pretending
there isn't one.

---

## 11. Guest→account upgrade keeps the same `auth.uid()`

**The fork.** Users start as anonymous guests (real `auth.uid()`, no login screen) and can
later create a real email/password account. How does their saved vocabulary survive the
transition?

**What we did.** The upgrade uses `supabase.auth.updateUser({email, password})`, which
keeps the **same `auth.uid()`**. Because every table is keyed on that uid and RLS is keyed
on `auth.uid()`, *all* `user_words`/`lists`/reviews carry over with **zero data
migration**. `signIn()` (switching to a *different* existing account) correctly does *not*
merge — that guest's data stays with the guest.

**What it shows.** Choosing an auth flow specifically because it makes the hard problem
(data migration on account creation) *disappear* rather than solving it. The best migration
is the one you designed away.

---

## 12. Embeddings are a separate table, and the space is borrowed not trained

**Two related forks about the word-map.**

**(a) Where do embeddings live?** Not as a column on `words`. `words` is deliberately kept
"schema-complete" — a column belongs there only if it's global + intrinsic-to-the-sense +
scalar. Embeddings are a 384/1024-dim vector that will be *re-embedded* as models improve,
so putting them on `words` would churn the core table on every re-embed. They live in a
separate `word_embeddings` table so re-embedding never touches user-facing data.

**(b) Train or borrow the semantic space?** Borrow. Use off-the-shelf multilingual vectors
(fastText / multilingual-E5 / LaBSE) batch-embedded over the dictionary once — not a
custom-trained model. A known limitation was measured and documented honestly rather than
hidden: with the small model, katakana *loanwords* cluster by **spelling** not meaning
(ストライカー "striker" → ストリーカー "streaker" 0.026, ストリッパー "stripper" 0.042),
because both the katakana surfaces and their English glosses share orthographic shape. The
tell-tale is distances of 0.03–0.06, far tighter than genuine synonyms. Native-kanji
vocabulary clusters fine; the fix (a stronger model) is scoped and deferred.

**What it shows.** Isolating a volatile, large, secondary signal from a stable core table;
preferring "borrow a proven space" over "train our own"; and — importantly — *measuring
and documenting a model's failure mode* instead of assuming the embeddings are good.

---

## 13. Edge dedupe: a bug that only appears against a real database

**The fork.** JMdict can return several senses that aggregate to the *same* translation
string (私 → "I; me" twice). The projection does a single
`INSERT … ON CONFLICT DO UPDATE` over the batch.

**Why it breaks — and why tests missed it.** Postgres refuses to let one statement affect
the same row twice (error 21000, "cannot affect row a second time"). The unit tests mock
the Supabase client, so they never see this — it only fails against a real DB, and it
breaks word-by-word translation for *common* words specifically.

**What we did.** Dedupe senses by the `onConflict` tuple *before* writing (keeping the
primary). Documented as a convention so it isn't reintroduced.

**Related same-shape lesson:** a *partial* unique index can't be an `ON CONFLICT` target
(error 42P10). One save path was made a full `UNIQUE` constraint so its upsert infers
cleanly; the other *must* stay partial (a full constraint would wrongly collide override
rows), so it uses INSERT + catch-23505-and-refetch instead. Both discovered because the
mock-client tests passed while the real DB rejected the write.

**What it shows.** Understanding real database semantics (statement-level conflict rules,
partial-index limits) and — the meta-lesson — knowing *which bugs your mocks structurally
cannot catch*, so you reach for integration tests exactly where they earn their keep.

---

## 14. Native on-device features: an economics decision, kept out of the architecture

**The fork.** Speech-to-text, camera/OCR, and handwriting recognition are *paid* cloud
APIs on web but *free + on-device + offline* on phones. How much of the phone story should
influence the codebase now?

**What we did.** Separated the *delivery-scope* decision from the *architecture*:
- **Scope (financial, temporary):** ship the input-modality features iOS-only first — the
  free on-device path exists on both iOS and Android, but maintaining two native builds
  isn't worth the spend pre-revenue.
- **Architecture (permanent):** none of this leaks in. `analyze()` and the services stay
  platform-neutral, so the only platform-asymmetric piece is tokenization (iOS `NLTagger`
  vs. Android keeps kuromoji with the dict bundled), hidden behind a single swap point.
  Adding Android later is purely additive: re-skin the views, swap `analyze()`.

There's also a documented *architectural fork to weigh later*: an LLM "write a paragraph at
level X using these seed words" could **collapse** the entire embeddings pipeline (#11/#12)
into one API call — less infrastructure, but ongoing per-use cost and less determinism.
Named now, decided later.

**What it shows.** Separating "what we build first, for business reasons" from "what the
architecture commits to" — so a temporary cost decision never hardens into a design
constraint — and flagging a real build-vs-buy fork *before* it's forced.

---

## The through-line

Most of these share one instinct: **treat identity and data-model decisions as the
expensive, do-it-early work, and everything downstream as cheap.** Keying the cache on a
stable reference (#1), making language part of the identity key (#10), keeping ALL virtual
(#7), isolating volatile signals from the core table (#12) — these are all the same move:
get the shape of the data right while it's still free to change, so that later features are
additive rather than migrations. The rest is a habit of *verifying the assumption before
building on it* (#2, #9, #13) and *routing each job to the tool that's actually good at it*
(#4, #5).
