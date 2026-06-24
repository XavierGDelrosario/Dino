# First Publishable Build — Launch Checklist

The product is built; the gap to publishable is almost entirely non-feature work
(auth, deploy, security, cost, legal). Tags: `[concern]` = a concern raised directly ·
`[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`. Completed items are removed
as they land — this list is the REMAINING work.

**Done so far:** Translate (JMdict + MT) · Lists · Review (SRS) · the full
differentiator thread (#8 difficulty · #9 extract-and-quiz · #10 calibration · #11
word map · #12 domain quizzes) · perf pass · NFC hardening · delete-lockdown · RLS
audit (all 14 tables) · integration coverage on risky DB paths (incl. the edge I/O
shell, black-box) · swallowed-error logging · JMdict/wordfreq attribution notice
(#15) · vocabulary pagination · reproducible embedding build · a clean `supabase db
reset` that reproduces the schema and reseeds the dictionary (no re-ingest) · retry
idempotency for the paid MT path · in-code observability (health check, request log,
MT-spend metric) · off-site user-data backup + tested restore (`db:backup` /
`db:restore-test`) · UI i18n — full EN/JA localization layer with a language picker (#17).

## 🚫 Tier 0 — Launch blockers (security & cost; need code)
1. **Cost protection** — `[concern · §3]` anon-signup rate limit + global MT spend
   kill-switch + hard billing caps. Billing caps are a hosted-console action, but the
   rate-limit / spend kill-switch still need code → a real blocker, not just config.

## 🔴 Tier 1 — Required for a real launch (build work)
2. **Real auth + guest→account upgrade** — `[#13]` replace ephemeral guests,
   preserve vocab/lists/level; also blunts the anon-quota loophole.
3. **Deploy** — `[#14]` hosted Supabase (ingest JMdict + frequency + embeddings on
   the cloud DB, prod `/dict/` serving) + frontend on a static host. **This is the
   gate that unlocks Tier 2.**
4. **Legal — privacy + ToS** — `[§10]` privacy policy (user text → Google) + ToS.

## 🔒 Tier 2 — Hosted-only (our side DONE; finish on the live production Supabase)
Code/in-repo work is complete; the only remaining step is a one-time action on the
hosted Supabase or an external console **after #3 (Deploy)** stands it up. None of
these can be progressed locally — that's why they're deferred, not unfinished. (Once
prod is live with real data you can't just `db reset`, hence "not easily changed".)
5. **Prod security config** — `[§4/§5]` set `ALLOWED_ORIGINS`, verify-jwt ON, restrict
   the Google key (code seams ready). *Repo-side piece doable pre-launch: secret-scan CI.*
6. **Forward-only migrations** — `[concern · §11]` adopt the forward-only, never-edit-
   an-applied-migration discipline. It only bites once prod holds data you can't
   `db reset`; clean-reset reproduction is already proven.
7. **Automated backups + PITR** — `[concern · §2]` flip the hosted paid-tier toggle +
   schedule `db:backup` off the DB host. Backup + tested-restore tooling is done.
8. **Observability — alerting** — `[§9]` point the edge's structured logs (health /
   request / `mt_spend`, all emitting) at hosted alerting (spend threshold, 5xx,
   uptime). In-code side done.

## 🟢 Tier 3 — Post-launch OK (features / polish)
- native app (#18). *(i18n #17 ✅ done — EN/JA; add a locale = one entry in
  `src/i18n/messages.ts`, compile-checked.)*
- **Purge dev/test guests before the first real DB** — a trivial one-time `DELETE`;
  the current anonymous rows are all throwaway (dev + me). NOT auth-gated — can run
  any time before publishing the real DB. (Ongoing abandoned-guest reaping only
  matters later, once there's public traffic + the #13 upgrade path.)
- **EN→JA reader sense quality** — the `LIMIT 12` cap stops the noise, but the
  reverse-gloss tail is still loosely matched; needs real EN→JA sense ranking.
- **Embeddings (#11) follow-ups:**
  - entry-level vectors blend homographs + produce gloss-string artifacts — consider
    per-sense or writing-weighted embedding.
  - **e5-large upgrade** — katakana loanwords cluster by SPELLING not meaning
    (ストライカー→streaker/stripper). Fix = a stronger model (e5-large 1024-dim /
    LaBSE); needs the `vector(384)` column migrated + a full re-embed (~2GB model).
  - **re-embed under the frequency-floor policy** — live vectors are the old
    `--common-only` 22.6k; the default policy (`EMBED_FREQ_FLOOR`, common ∪ freq≥250
    ≈ 41k) applies only after a re-embed + `npm run db:dump-seed`.
  - **English as a learning target** — the word map is JA-only. The embeddings KEY is
    already multi-language (`(source_lang, dictionary_ref)`, no JMdict FK) and
    `build-embeddings.py` has a per-source seam (`SOURCE_FETCHERS`, `--source-lang`);
    a non-JA language still needs its own dictionary source + `<source>_lookup()` +
    per-source `related_words` projection.
  - prod-DB regen at deploy + HNSW param tuning under load; per-language KO/ZH.

## ➕ Open follow-ups (slot into tiers as you go)
- **Complete account deletion** — `[Tier 1 / #13]` `delete_account()` erases this
  app's PUBLIC-schema data but NOT the Supabase `auth.users` row; pair it with the
  auth admin API when real auth lands, else deleted users can still sign in.
- **Real furigana (#16)** — *very low priority.* Ruby above the kanji + peel-matching-
  kana alignment (`alignFurigana`); group ruby is correct meanwhile.
- **FSRS (#19)** — *very low priority.* Upgrade the SRS to the D/S/R model (power-law
  curve, fit constants to `review_log`); a new `record_review()` body, same API. The
  HLR curve is fine for now.

---
**Throughline:** Tier 0 + Tier 1 is the real remaining BUILD work — cost protection,
auth, deploy, privacy/ToS. **Tier 2 is code-complete and just waiting on the hosted
Supabase that Deploy (#3) stands up** — config/toggles/wiring, not engineering. Tier 3
is post-launch polish.
