# First Publishable Build — Launch Checklist

The product is essentially built; the gap to a publishable build is almost entirely
non-feature work (auth, deploy, security, cost, legal). Tags: `[concern]` = a
concern raised directly · `[#N]` = roadmap item · `[§N]` = `Production_Hardening.md`.

## ✅ Done (baseline)
Translate (JMdict + MT), Lists, Review (SRS), **#10 calibration**, **#11 word map**;
perf pass, NFC hardening, integration-test coverage on the risky DB paths.

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
**#12 domain-tailored quizzes** (the differentiator — sits on #10+#11, but a feature
not a gate) · real furigana (#16) · i18n (#17) · FSRS (#19) · native app (#18) ·
abandoned-guest cleanup.

---
**Throughline:** Tier 0 + Tier 1 *is* the whole gap to publishable — roughly auth,
deploy, and the security/cost/legal hardening. Everything in Tier 3 (incl. the
differentiator #12) can wait. Remaining quick/local wins are limited — most of
Tier 0/1 needs hosted infra, external accounts, or the auth build.
