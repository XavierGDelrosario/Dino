# DINO (大脳)

**Live: [dino-86y.pages.dev](https://dino-86y.pages.dev)**

A vocabulary-learning app for Japanese ↔ English. Translate a word or paste a whole
paragraph, save what you want to keep, and review it later on a spaced-repetition
schedule.

The idea is to study the media you actually read. Paste a paragraph — or open an
article from the Media tab — and DINO segments it into real words with readings and
meanings, colours each one by how well you know it, and turns the ones you don't know
into a flashcard session that feeds your review queue.

## Stack

Vite + React 18 + TypeScript, Supabase (Postgres / Auth / RLS), and a single
`translate` edge function. Japanese morphology runs client-side via kuromoji; the
dictionary is a self-hosted JMdict, with Japanese WordNet behind EN→JA and Google
Cloud Translation as the fallback for what those don't cover.

## Getting started

```bash
npm install
cp .env.example .env     # set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

```bash
npm run typecheck        # tsc --noEmit — no env or Supabase needed
npm test                 # vitest, service-layer unit tests
npm run build
```

## Docs

- `CLAUDE.md` — architecture, invariants, and the module map
- `docs/TODO.md` — launch checklist and roadmap
- `docs/DesignChoices.md` — why the model looks the way it does
- `docs/Deploy.md` — production deploy (Cloudflare Pages + hosted Supabase)
- `docs/QualityLimitations.md` — known accuracy limits
- `ATTRIBUTION.md` — JMdict (EDRDG), Japanese WordNet, and wordfreq licensing
