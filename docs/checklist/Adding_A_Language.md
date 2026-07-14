# Adding a New Language — Checklist

How to add a new learning language to DINO end-to-end. The user-facing core
(`words`, `user_words`, `lists`, `list_words`, `review_log`) is **language-agnostic by
construction** (see CLAUDE.md → Multi-language readiness), so adding a language is mostly
**new rows + a new dictionary source behind the provider seam + new FE registry entries**
— NOT schema surgery. The Japanese-specificity is isolated to the SOURCE layer
(`jmdict_*` + `jmdict_lookup`); everything downstream is generic.

**Two independent axes — don't conflate them:**
- **UI localization (i18n)** = the language the *interface* is shown in (`src/i18n/messages.ts`).
- **Learning/target + source language** = a language you can *translate to/from and study*.

You can add one without the other (a Spanish UI for an English speaker learning Japanese;
or Korean as a study target while the UI stays EN/JA). Most of this checklist is the
second axis; the localization section covers the first.

**Conventions (keep consistent):**
- Language code = **uppercase short code**: `JA` `EN` `KO` `ZH`. Split scripts get their
  own code: `ZH-Hant` vs `ZH-Hans`. The code is part of every identity key — a typo
  silently forks rows, so see the **language registry** step (validation).
- **Readings are two-sided + nullable** (`words.input_reading` / `translation_reading`):
  kana furigana for JA, pinyin for ZH, romanization for KO, NULL for a phonetic side.
  Both sides populated only for two-logographic pairs (JA↔ZH).
- **Derive, don't redistribute** corpora/dictionaries beyond their license (the wordfreq
  / JMdict discipline). Each source has its own attribution.

---

## 0. Decide scope first
- [ ] **Which pairs?** A new language `L` with dictionary source `S` natively gives
      `L↔<S's gloss language>` (usually `L↔EN`). Decide which *other* existing languages
      `L` must pair with (`L↔JA`, `L↔ZH`, …) — see **Bidirectionality** below.
- [ ] **Script type?** Spaced (Latin/Cyrillic/Hangul-with-spaces) → `Intl.Segmenter`
      suffices. Space-less / morphologically rich (JA, ZH, Thai, or KO if lemmas needed)
      → needs a real morphological engine (the `analyze.ts` swap point).
- [ ] **Logographic?** Determines whether readings/furigana apply (readings step).

## 1. Language registry (the identity + validation layer)
- [ ] **FE registry** — add one entry in `services/language/registry.ts` (code, display
      name, native name, script flags). This is the documented "add a language = one
      entry" point; `detect.ts` / `options.ts` consume it.
- [ ] **DB registry (the tightening, do it now if not already)** — codes are currently
      free-form `TEXT` (unvalidated → a `JP`/`JA` typo forks rows). Add a `languages`
      registry table + FK from `words.source_lang`/`target_lang` (and
      `user_words`'s lang columns) so the DB and the FE `registry.ts` agree. CLAUDE.md
      flags this as the natural step "when the 2nd language ships for real" — that's now.
- [ ] Keep FE `registry.ts` and the DB `languages` table in sync (same codes).

## 2. Detection + input/output support
- [ ] **Auto-detect** — `services/language/detect.ts`: recognize the new script/language
      so source resolution picks it automatically.
- [ ] **Dropdown view-models** — `services/language/options.ts`: the new language appears
      in the source/target pickers and the profile (native / learning) selectors.
- [ ] **Non-Latin input** — verify UTF-8 round-trips (it's first-class: Hangul/Hanzi
      store, compare, `char_length` correctly). NFC-normalize at every boundary (already
      done in the translate flows / `customWords` / edge function — confirm it covers the
      new script).
- [ ] **Profile defaults** — `users.native_language` + learning-language pref drive the
      default Translate directions; ensure the new language is a selectable option.

## 3. Tokenization + readings (analysis)
- [ ] **Segmentation** — `services/language/tokenize.ts` (`Intl.Segmenter`) handles spaced
      languages out of the box. For space-less/morphological languages, add an engine.
- [ ] **Morphological engine (if needed)** — `services/language/analyze.ts` is THE swap
      point (kuromoji for JA today; segmentation-only otherwise). A new language needing
      lemmas/readings (e.g. KO) plugs in its own engine here; nothing downstream changes.
      Mind the platform story (CLAUDE.md #18): web bundle size + native equivalents.
- [ ] **Readings / furigana** — `services/language/furigana.ts` (`furiganaFor`) produces
      per-side reading annotations. Confirm the two-sided model fits (pinyin for ZH,
      romanization for KO); NULL the phonetic side. `alignFurigana` (peel-matching-kana)
      is JA-shaped — generalize or skip for non-kana scripts.
- [ ] **Readings inline on `words`** — the dictionary projection fills
      `input_reading`/`translation_reading`; verify the new source populates the correct
      side(s).

## 4. Dictionary service (the SOURCE layer — the main lift)
This is where the language-specificity lives. `words`/`user_words` stay unchanged.
- [ ] **Pick a source** — e.g. CC-CEDICT (ZH), a KR dictionary (KO). Must support the
      directions you need.
- [ ] **Schema** — new normalized `<source>_*` tables in a numbered migration
      (`supabase/migrations/`), server-only (RLS on, no policies/grants — only the edge
      function's service role reads), mirroring `jmdict_*` + `20260618_jmdict.sql`.
- [ ] **Ingest script** — `scripts/ingest-<source>.ts` (template: `ingest-jmdict.ts`):
      one-time Node/TS loader, truncate-and-reload, NEVER touches `words`/`user_words`.
- [ ] **Lookup function** — `<source>_lookup(input, source, target)` SQL function
      (template: `jmdict_lookup`) returning meaning + reading together, **both
      directions**, ranked by frequency, with `uk`-style headword handling if applicable.
- [ ] **Provider route** — register the pair(s) in `services/senses/`
      (`resolveSenseProvider(source, target)`) so the edge function routes `L↔X` to
      `<source>_lookup`. Until then a pair falls through to the Google MT fallback.
- [ ] **Edge projection** — the edge function projects matched senses into `words`
      (stable `dictionary_ref` identity, `projection_version` bump). Mirror the
      `toWord`/conflict-tuple logic (cross-runtime duplication — keep in sync).
- [ ] **Stable identity** — give the new source a direction-aware `dictionary_ref` like
      JMdict's, so re-projection UPDATEs in place (no cache forks, `user_words` survive).

## 5. MT fallback service
- [ ] **Provider coverage** — confirm Google Cloud Translation v2 supports every pair you
      claim (it's the fallback for words the dictionary lacks + the whole-paragraph gloss).
- [ ] **Lang-code mapping** — add the app code → Google ISO mapping in the edge
      `_lib.ts` (and confirm the reverse). Unsupported pair → degrade to "no result", never 500.
- [ ] **Cost controls apply automatically** — `user_limits` quotas + global cap +
      `MT_DISABLED` already gate any new paid pair; no new metering needed.

## 6. Bidirectionality (pair with existing languages)
- [ ] **Native direction** — `L↔EN` (or whatever the source glosses to) via `<source>_lookup`.
- [ ] **Other dictionary pairs** — `L↔JA`, `L↔ZH`, … only if the source has those glosses.
      `jmdict_glosses.lang` (DEFAULT `'eng'`) already anticipates multilingual glosses;
      a multi-gloss source can serve several target languages.
- [ ] **Bridge the rest via MT** — any pair without a dictionary still works through the
      Google fallback (display-gloss + unknown-word cache as `mt:<input>`). Decide which
      pairs are dictionary-quality vs MT-only and note it (don't silently degrade).
- [ ] **Identity keys already cover it** — `words` UNIQUE + `uq_user_words_custom` include
      the lang pair, so the same surface across pairs (愛 JA vs ZH) never collapses.

## 7. Frequency + difficulty
- [ ] **Frequency export** — `scripts/build-frequency.py <lang>` → `data/frequency/<lang>.tsv`
      (Zipf ×100). Join onto the source's surface table in the ingest (by surface), take
      the **headword's** frequency, `ORDER BY frequency DESC NULLS LAST`.
- [ ] **Difficulty needs nothing new** — Zipf is normalized + cross-language-comparable,
      so the ONE bin set in `services/difficulty/level.ts` serves every language. Only add
      a `services/difficulty/registry.ts` per-language entry for genuine divergence (e.g. a
      JLPT/HSK-style curated override → `difficulty_override`).
- [ ] **Leveling profile (the SRS ease)** — `npm run build:leveling -- <L>`, AFTER the
      frequency + proficiency ingests. It MEASURES the language's band anchors (each band's
      median frequency — this is what encodes its non-uniform spacing) and its POS frequency
      offsets (frequency is per-SURFACE, so how much inflection distorts it is a property of
      the language: JA affixes read +0.58 Zipf too easy, JA verbs −0.75 too hard). Add the
      language's source query to `SOURCES` in `scripts/build-leveling-profile.ts` (where its
      levelled words live) and its POS taxonomy to `language_pos_group` — the tag set is
      language-specific, the calculator is not.
      **Without a profile the ease is 1.0** — the scheduler simply won't retire that
      language's words early. Safe, and the correct default: nothing is confidently wrong for
      a language we haven't measured. A language with NO POS source (English today) gets band
      anchors only. See `docs/research/Frequency_vs_Proficiency_by_POS.md`.

## 8. Embeddings / word map (the relatedness axis)
- [ ] **Embed** — `scripts/build-embeddings.py --source-lang <L>` (per-source seam:
      `SOURCE_FETCHERS`). Multilingual model shares ONE vector space, so cross-language
      neighbors work, but each language is real compute + storage.
- [ ] **Frequency-floor policy** — apply the SAME `EMBED_FREQ_FLOOR` (default 250) per
      language so storage is predictable (~45k entries ≈ ~165 MB @ 384-dim). The
      dictionary stays full; only the word-map is trimmed.
- [ ] **Key is already multi-language** — `(source_lang, dictionary_ref)`, no JMdict FK;
      add a per-source `related_words` projection.
- [ ] **Loanword caveat** — small e5 clusters transliterated loanwords by spelling, not
      meaning (CLAUDE.md). Expect it; the fix is a stronger model, deferred.

## 9. Lists filter by language
- [ ] **Filter UI** — `views/ListView.tsx` / `hooks/useLists.ts`: add a language filter so
      a multi-language vocabulary can be viewed per target language (the source/target
      langs already ride on each `user_words` row via the `words` join). Decide whether
      "ALL" is per-language or global.

## 10. Localization (UI language — the OTHER axis)
- [ ] **Message catalog** — add a locale entry in `src/i18n/messages.ts` (compile-checked;
      EN/JA exist). This translates the *interface*, independent of study languages.
- [ ] **Coverage** — every user-facing string is wrapped in the `t()` lookup; no hardcoded
      JSX copy for the new locale.
- [ ] **Locale ≠ learning language** — a user can have a Spanish UI while learning Japanese.

## 11. Content safety
- [ ] **Per-language blocklist** — `contentSafety.ts` is per-language + extensible. Add the
      new language's explicit-words blocklist (filters suggestions / word-map, NOT direct
      lookup), incl. inflection/script variants.

## 12. Attribution + legal
- [ ] **Source license** — each dictionary/corpus has its own (JMdict=EDRDG, CC-CEDICT=
      CC-BY-SA, wordfreq=CC-BY-SA). Add to `ATTRIBUTION.md` + the in-app notice.
- [ ] **Media sources are per-language** — subtitle/script sources differ by language
      (Kitsunekko = JP anime only); see `docs/TODO.md` Tier 4. Don't assume one source.

## 13. Tests
- [ ] **Unit** — `analyze`/`tokenize`/`difficulty`/`furigana` cases for the new language.
- [ ] **Integration** — extend the multi-language block in
      `tests/integration/constraints.integration.test.ts` (round-trip the new script;
      `source_lang` part of identity) and add `<source>_lookup` cases to
      `rpc.integration.test.ts` (returns senses + client-uncallable; self-skip if not ingested).

## 14. Ops / deploy
- [ ] **Seed/dump** — include the new `<source>_*` + `data/frequency/<lang>.tsv` +
      embeddings in the `db reset` seed (`db:dump-seed`) so a clean reset reproduces them
      without re-ingest. CI ingest stays best-effort (dict-dependent tests self-skip).
- [ ] **Storage/tier** — each language adds dictionary + frequency + embeddings. The
      frequency-floor policy bounds the word-map; the full dictionary is the bigger line.
      Multilingual ambition is what crosses Free→Pro — budget it.
- [ ] **Forward-only migration** — new `<source>_*` schema is a numbered migration; never
      hand-edit applied ones in prod.

## 15. Future services (design the language seam so these slot in)
These aren't required to add a language, but each is per-language — note availability so a
new language doesn't silently lack them (CLAUDE.md #18 has the cross-platform detail).
- [ ] **Speech-to-text** — locale support: Web Speech `lang` code (web), on-device
      recognizer locale (iOS `Speech`, Android `SpeechRecognizer`). Confirm the language
      is supported before exposing the mic for it.
- [ ] **Camera / OCR** — script support in the OCR engine: Cloud Vision (web), ML Kit /
      iOS Vision (native). Logographic/complex scripts vary in quality — verify per language.
- [ ] **Media ingestion** — a subtitle/script + frequency source for the language
      (per-language; Kitsunekko is JP-only). The pre-study flow reuses the same pipeline
      once a source exists.

---

## Quick mental model
**Generic (touch once, works for all langs):** `words`/`user_words`/`lists`/`review_log`,
difficulty bins, embeddings space, MT fallback, cost metering, the review/SRS engine.
**Per-language (the actual work):** a dictionary source (`<source>_*` + `<source>_lookup`
+ provider route), a morphological engine *if* space-less, a frequency export, FE
registry/detect/options entries, content-safety blocklist, attribution, and — for the
extra services — per-language speech/OCR/media support. Bidirectional pairs are
dictionary-quality where a gloss exists, MT-bridged otherwise.
