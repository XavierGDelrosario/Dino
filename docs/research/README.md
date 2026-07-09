# docs/research

Standalone research artifacts — the output of deep-research runs and one-off
investigations that inform a decision but aren't themselves product/spec docs.

**What goes here:** cited, dated research reports (licensing surveys, algorithm/data-source
comparisons, market/competitor notes). Each is a snapshot at its run date — findings can
go stale, so keep the date and sources in the doc. When a research doc drives a concrete
plan, link it from the relevant spec (e.g. `docs/Proficiency.md`, `docs/TODO.md`) rather
than duplicating conclusions.

**What does NOT go here:** product briefs / roadmaps (`docs/DinoPOC.md`, `docs/DinoMVP.md`,
`docs/TODO.md`), design-decision logs (`DesignChoices.md`), or licensing/compliance
audits (`docs/audit/`).

## Index

- [CEFR_Licensing_And_Quality.md](CEFR_Licensing_And_Quality.md) — which CEFR-mapped
  English word list DINO can legally ship (answer: **CEFR-J**), and whether a word-level
  CEFR rating beats corpus frequency as a difficulty signal (answer: **only modestly**).
  Resolves `docs/Proficiency.md` Remaining #5. *(2026-07-09)*
