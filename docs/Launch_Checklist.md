# First Publishable Build — Launch Checklist

The product is essentially built; the gap to a publishable build is almost entirely
non-feature work (auth, deploy, security, cost, legal). Tags: `[concern]` = a
concern raised directly · `[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`.

## ✅ Done (baseline)
Translate (JMdict + MT), Lists, Review (SRS), and the **full differentiator thread**:
**#8** difficulty · **#9** extract-and-quiz · **#10** calibration (silent) · **#11**
word map (pgvector, 22.6k embedded) · **#12** domain quizzes ("Explore related
words"). Plus the perf pass, NFC hardening, delete-lockdown, and integration-test
coverage on the risky DB paths. **The product roadmap (differentiator) is complete;
what remains below is the path to shipping it.**

## 🚫 Tier 0 — Launch blockers (security & cost)
1. **Lock down deletes** — `[concern · §1b]` ✅ **DONE** (`20260624_privileges.sql`):
   dictionary delete-locked from all roles; `service_role` DELETE removed from user
   tables; audited `delete_account()` for sanctioned erasure. Live integration tests.
2. **Cost protection** — `[concern · §3]` anon-signup rate limit + global MT spend
   kill-switch + hard billing caps (Google & Supabase). *(needs deploy/config)*
3. **Prod security config** — `[§4/§5]` set `ALLOWED_ORIGINS`, verify-jwt ON,
   keys server-only, restrict the Google key, secret-scan CI. *(deploy-time)*
4. **RLS audit** — `[§1c]` ✅ **DONE** (verified: all 14 public tables have RLS).

## 🔴 Tier 1 — Required for a real launch
5. **Real auth + guest→account upgrade** — `[#13]` replace ephemeral guests,
   preserve vocab/lists/level; also blunts the anon-quota loophole.
6. **Deploy** — `[#14]` hosted Supabase (ingest JMdict + frequency + embeddings on
   the cloud DB, prod `/dict/` serving) + frontend on a static host.
7. **Reconcile migration drift** — `[concern · §11]` `init.sql` ↔ live; prove a
   clean `db reset` reproduces the schema; forward-only numbered migrations.
8. **Backups + PITR** — `[concern · §2]` enable before real data; protect the
   irreplaceable tables (`review_log` etc.); test a restore.
9. **Legal** — `[§10]` EDRDG/JMdict attribution in UI `[#15]` + privacy policy
   (user text → Google) + ToS.

## 🟡 Tier 2 — Strongly recommended around launch
10. **Observability** — `[§9]` error logging/alerting, MT-spend metric, health check.
11. **Pagination** — `[concern · §11]` `getAllUserWords` / Lists / `getUserWordStates`
    are unbounded.
12. **AI-code audit pass** — `[§12]` integration coverage on the untested edge I/O
    shell, audit the `.catch(()=>{})` swallowed errors, spot-check comments.

## 🟢 Tier 3 — Post-launch OK (features / polish)
~~#12 domain-tailored quizzes~~ ✅ **DONE** (the differentiator) · real furigana
(#16) · i18n (#17) · FSRS (#19) · native app (#18) · abandoned-guest cleanup ·
#12 refinements (per-sense embeddings / prod regen — see "Discovered" below).

---
**Throughline:** with the differentiator thread (#8–#12) **complete**, Tier 0 + Tier 1
*is* the whole remaining gap to publishable — auth, deploy, and the security/cost/
legal hardening. Most of it needs hosted infra, external accounts, or the auth build;
the local hardening (delete-lockdown, RLS audit, swallowed-error logging) is done.

## ➕ Discovered this session (append; slot into tiers as you go)
- **Complete account deletion** — `[Tier 1 / #13]` `delete_account()` erases this
  app's PUBLIC-schema data but NOT the Supabase `auth.users` row; pair it with the
  auth admin API when real auth lands, else deleted users can still sign in.
- **Retry idempotency** — `[Tier 2 / §11]` the translate client retries on 5xx, so a
  succeeded-but-lost response double-counts MT quota (over-counts, never over-spends).
  Add an idempotency key if exact metering matters.
- **Swallowed-error logging** — `[Tier 2 / §12]` add `console.warn` to the
  `.catch(() => {})` sites (getUserLevel, calibration persist, kuromoji warm-up,
  lists/limits loads) so non-fatal failures aren't invisible.
- **Embeddings (#11) follow-ups** — `[Tier 3]` entry-level vectors blend homographs
  and produce gloss-string artifacts (e.g. katsu/catsup near 猫); consider per-sense
  or writing-weighted embedding. Also: regenerate embeddings on the prod DB at
  deploy, tune HNSW params under load, and add per-language embeddings (KO/ZH) when
  those ship.
- **Reproducible embedding build** — `[deploy/tooling]` pin the one-time venv deps
  (`sentence-transformers`, `psycopg2-binary`, `numpy<2`) in a requirements file so
  `build-embeddings.py` reproduces (the numpy<2 pin is load-bearing — torch 2.2 ABI).
- **Full migration-reset verification** — `[Tier 1 / §11]` object-level coverage is
  confirmed, but a clean `supabase db reset` reproducing the live schema is still
  unverified. **Update (2026-06-24):** reset no longer *wipes* the dictionary —
  `supabase/seeds/*.sql` (gitignored, ~128MB, regen via `npm run db:dump-seed`) now
  auto-restores JMdict + embeddings, so reset = no re-ingest. The schema-reproduction
  proof itself is still open.

### Added 2026-06-24 (reader/embeddings session)
- **EN→JA reader sense ranking** — `[Tier 3]` ✅ partial: capped `jmdict_lookup`
  EN→JA at `LIMIT 12` (the branch is a reverse gloss search returning 400+ entries
  for common words — "the"→411). Fixes the noise/URL-bloat; EN-reader sense quality
  is still coarse (the long tail is loosely-matched). Root cause that surfaced it:
  unbounded sense ids → a 414 URI-too-long on `getUserWordStates` killed the English
  reader entirely (now chunked, see below).
- **`getUserWordStates` chunking** — `[Tier 2 / §11]` ✅ partial: the unbounded
  `.in()` now chunks (100 ids/req) so it can't 414. Still unbounded in *result size* —
  true pagination remains.
- **e5-large embedding upgrade** — `[Tier 3 / #11]` katakana LOANWORDS cluster by
  spelling, not meaning (ストライカー→streaker/stripper, observed live). Small e5
  anchors on orthography for single tokens. Fix = a stronger model (e5-large 1024-dim
  / LaBSE) — needs the `word_embeddings.embedding` column migrated off `vector(384)` +
  a full re-embed (~2GB model dl). Deferred.
- **Re-embed under the frequency-floor policy** — `[Tier 3 / #11]` the live 22.6k
  vectors were built `--common-only`; the new default policy (`EMBED_FREQ_FLOOR`,
  common ∪ freq≥250 ≈ 41k) isn't applied until a re-embed + `npm run db:dump-seed`.
- **English as a LEARNING target** — `[Tier 3 / #11/#12]` the word map is JA-only:
  `word_embeddings` has only `source_lang='JA'`, and `exploreDomain` with `learning=EN`
  mismatches. The embeddings KEY is now multi-language (`(source_lang, dictionary_ref)`,
  no JMdict FK) and `build-embeddings.py` has a per-source seam (`SOURCE_FETCHERS`,
  `--source-lang`), but a non-JA language still needs its own dictionary source +
  `<source>_lookup()` + per-source `related_words` projection.
