# First Publishable Build — Launch Checklist

The product is built; the gap to publishable is almost entirely non-feature work
(auth, deploy, security, cost, legal). Tags: `[concern]` = a concern raised directly ·
`[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`. Completed items are removed
as they land — this list is the REMAINING work.

**Done so far:** Translate (JMdict + MT) · Lists · Review (SRS) · the full
differentiator thread (#8 difficulty · #9 extract-and-quiz · #10 calibration · #11
word map · #12 domain quizzes) · perf pass · NFC hardening · delete-lockdown · RLS
audit (all 14 tables) · integration coverage on risky DB paths · swallowed-error
logging · JMdict/wordfreq attribution notice (#15) · vocabulary pagination ·
reproducible embedding build · a clean `supabase db reset` that reproduces the schema
and reseeds the dictionary (no re-ingest).

## 🚫 Tier 0 — Launch blockers (security & cost)
1. **Cost protection** — `[concern · §3]` anon-signup rate limit + global MT spend
   kill-switch + hard billing caps (Google & Supabase). *(needs deploy/config)*
2. **Prod security config** — `[§4/§5]` set `ALLOWED_ORIGINS`, verify-jwt ON,
   keys server-only, restrict the Google key, secret-scan CI. *(deploy-time)*

## 🔴 Tier 1 — Required for a real launch
3. **Real auth + guest→account upgrade** — `[#13]` replace ephemeral guests,
   preserve vocab/lists/level; also blunts the anon-quota loophole.
4. **Deploy** — `[#14]` hosted Supabase (ingest JMdict + frequency + embeddings on
   the cloud DB, prod `/dict/` serving) + frontend on a static host.
5. **Forward-only migrations** — `[concern · §11]` adopt numbered forward-only
   migrations (stop hand-editing `init.sql`); reconcile `init.sql` ↔ live. *(A clean
   `db reset` now reproduces the schema + reseeds — verified 2026-06-24; the
   discipline of not editing applied migrations is what remains.)*
6. **Backups + PITR** — `[concern · §2]` enable before real data; protect the
   irreplaceable tables (`review_log` etc.); test a restore.
7. **Legal — privacy + ToS** — `[§10]` privacy policy (user text → Google) + ToS.
   *(JMdict/EDRDG + wordfreq attribution ✅ shipped in the app footer.)*

## 🟡 Tier 2 — Strongly recommended around launch
8. **Observability** — `[§9]` error logging/alerting, MT-spend metric, health check.
9. **AI-code audit pass** — `[§12]` integration coverage on the untested edge I/O
   shell; spot-check comments. *(swallowed-error logging ✅ done.)*

## 🟢 Tier 3 — Post-launch OK (features / polish)
- real furigana (#16) · i18n (#17) · FSRS (#19) · native app (#18) · abandoned-guest
  cleanup.
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
- **Retry idempotency** — `[Tier 2 / §11]` the translate client retries on 5xx, so a
  succeeded-but-lost response double-counts MT quota (over-counts, never over-spends).
  Add an idempotency key if exact metering matters.

---
**Throughline:** Tier 0 + Tier 1 *is* the remaining gap to publishable — cost/security
config, auth, deploy, backups, and the privacy/ToS legal. Most of it needs hosted
infra, external accounts, or the auth build.
