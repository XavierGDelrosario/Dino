# Backend portability — when (and how) DINO would move off Supabase

Decision criteria written down so future-us doesn't re-argue this from scratch. **TL;DR: stay on Supabase through MVP and well past it.** Every realistic exit is either a *partial* move of one component or a problem that only exists at a scale we'd be lucky to reach. Most of what we've built is portable Postgres, not lock-in.

## What's lock-in vs. what's portable

| Layer | Portable? | Notes |
|---|---|---|
| `jmdict_*` / `wordnet_*` schema, migrations | ✅ Standard Postgres | Runs on Neon, RDS, plain PG unchanged |
| SQL functions (`record_review`, `consume_translation_quota`, `jmdict_lookup`, `save_dictionary_word`, …) | ✅ Standard Postgres | Plpgsql, no Supabase-specific calls except `auth.uid()` |
| pgvector word-map (#11) | ✅ Extension | Available on most managed PG; or swap to a dedicated vector DB |
| **RLS policies** | ⚠️ Postgres feature, but… | Depends on `auth.uid()`; the *security model itself* is portable PG RLS, but it's wired to Supabase Auth's JWT claims |
| **Supabase Auth** (anon guest → in-place upgrade, same `auth.uid()`) | ❌ Supabase-specific | Re-engineering this is the single biggest exit cost |
| **Edge Functions** (Deno) | ⚠️ Thin shell | Pure logic is in `_lib.ts` (portable); only the `Deno.serve` I/O shell is Supabase-flavored |

**Rule of thumb:** ~70% of backend work survives an exit. We are not trapped.

## Keep these seams clean (the only thing to do *today*)

1. **LLM / agent functions (#12, Tier 4)** — keep the model-calling logic pure and the `Deno.serve` wrapper thin, exactly like `translate/_lib.ts`. This is the most likely thing to peel onto Cloudflare Workers (see trigger #1). Cost of keeping it clean: ~zero. Cost of not: a rewrite under deadline.
2. **Vector storage (#11/#12)** — treat the embeddings table + nearest-neighbor query as a swappable module behind a `relatedWords()`-style facade, so a future move to Pinecone/Qdrant is a body change, not a surgery.
3. **App traffic stays on PostgREST/HTTP, never a direct PG connection** — this is already true and is what insulates us from the classic serverless connection-storm (see trigger #3). Don't introduce a direct-connection ORM (Prisma/`pg`) in the request path; keep direct `pg` to one-shot admin scripts only.

## Realistic exit triggers (likeliest first)

### 1. LLM/agent features make Edge Functions the bottleneck — *partial move*
Long-running, streaming LLM calls (paragraph generation, domain quizzes) hit Deno execution-time limits / cold starts / region gaps. **Fix:** move *only those endpoints* to Cloudflare Workers (we're already on Cloudflare Pages). Postgres/Auth/RLS stay. Not a migration.

### 2. Multi-region latency — *scale up within Supabase first*
Single-region Postgres means cross-Pacific users (our stated JP+EN split market) feel per-lookup latency. **Fix path:** read replicas (still Supabase) → only if that's not enough, distributed Postgres (Neon/Cockroach). A success problem.

### 3. Connection-pool ceiling — *config toggle, not a move* (see deep-dive below)
Largely mitigated *by construction* because app traffic goes through PostgREST, not direct connections. Realistic ceiling is PostgREST pool / Postgres CPU under request volume, fixed by Supavisor pooling + compute tier — config, not rewrite.

### 4. Pricing *shape* mismatch — *partial move*
Not "Supabase got pricey" but a workload that fits a specialist better:
- pgvector at many-languages × full-dict × 1024-dim → a dedicated vector DB gets cheaper (our embeddings notes already flag the storage discipline).
- Egress — already avoided (kuromoji dict + media served via Cloudflare, not Supabase).

### 5. A structurally-unsupported feature — *add a service, don't replace*
Heavy full-text search (Typesense/Elasticsearch), graph data, realtime beyond Supabase Realtime → run it *alongside* Supabase.

### The only true full-migration scenario
PMF + hundreds of thousands of users across regions, where Auth + RLS + single-region PG can't be patched fast enough → deliberate re-platform onto managed PG + dedicated auth + Workers. A funded, staffed, years-away event. Design for it only insofar as the seams above stay clean.

## Deep-dive: trigger #3 (connection pooling)

The "Supabase is bad at scale" reputation is mostly this — but it bites apps that open a **direct Postgres connection per serverless invocation** (Lambda + Prisma/`pg`). Postgres has a hard `max_connections`; thousands of concurrent functions each grabbing one exhausts it → `too many connections` errors.

**DINO is insulated by construction:**
- Browser client and the `translate` edge function both go through **PostgREST over HTTP** (`createClient`), which maintains *its own* internal pool to Postgres. The request path never opens a raw TCP connection.
- The only direct `pg` connections are one-shot admin/ETL scripts (`ingest-jmdict`, `db:backup`) — single connection, run by hand, never concurrent, never user-facing.
- Outbound fan-out is already bounded: `mapLimit` caps per-paragraph translate calls at `MAX_TRANSLATION_CONCURRENCY = 6` (and domain expansion at 6), so one user can't fire hundreds of edge requests at once.

**So the realistic failure mode is not "connection exhaustion," it's PostgREST pool saturation / Postgres CPU under aggregate request volume** — which presents as latency/queueing, not errors, and is addressed in order by:
1. **Supavisor transaction-mode pooling** (Supabase's built-in pooler) — a connection-string/config change.
2. **Bump compute tier** — more RAM → higher `max_connections` + more PostgREST workers.
3. **Cache hits reduce DB pressure** — our `words` cache means most repeat lookups never touch JMdict; warming it lowers per-request DB cost.

None of these is a migration. We would only leave over connection limits if Supavisor + max compute still couldn't keep up — a scale far beyond MVP, and a problem we'd be thrilled to have.

**One caveat to watch:** if we ever add a feature that *needs* a direct connection in the request path (e.g. a Worker using `pg` for `LISTEN/NOTIFY`, or an ORM that doesn't speak PostgREST), route it through Supavisor's pooler endpoint, not the direct DB host. That keeps us out of the classic trap.
