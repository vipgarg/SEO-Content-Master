# SEO Content Master — Gyan Sadhan Content Engine

Evidence-grounded book-page generation: Claude drafts, deterministic
checks filter, and Gemini's free tier verifies with no stake in its own
output. See `docs/` for the full design:

- `docs/generation-plan-v3.1.md` — architecture, generation flow, rate-limit design, Google-policy risk analysis
- `docs/schema-v4.1.sql` — corrected, dependency-ordered, validated Postgres schema (split into `migrations/*.sql`)
- `docs/seo-content-engine-v4-schema.md` — original schema spec as received (kept for reference; has known ordering bugs, see v4.1)

## Setup

```bash
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, GEMINI_API_KEY, ANTHROPIC_API_KEY
npm install
npm run migrate        # applies migrations/*.sql in order
npm test                # runs against the DATABASE_URL / REDIS_URL in .env — needs both reachable
```

Tests are integration-first, not mocked-DB: `npm test` talks to a real
Postgres and a real Redis. Point `.env` at disposable local instances,
never at anything with data you care about — several tests write and
delete rows.

## What's here so far

**`migrations/`** — the schema, split from `docs/schema-v4.1.sql` into
one file per section, applied by `src/db/migrate.ts` (`npm run migrate`).
No down-migrations by design; this schema is young enough that fixing
forward is simpler than maintaining a reverse path for every trigger.

**`src/workers/gemini/`** — the `gemini_quota` worker (plan §4): every
Gemini call in the system is meant to flow through this one BullMQ
queue, so the RPM/RPD caps, 429-then-park backoff, and circuit breaker
are enforced in exactly one place.

- `tokenBucket.ts` — Redis-backed, atomic (Lua script) token bucket for the RPM ceiling
- `quotaTracker.ts` — Postgres-backed daily budget against `api_quota_ledger`, keyed to the Pacific-midnight quota day
- `circuitBreaker.ts` — pauses the queue after N consecutive *non-429* failures
- `geminiClient.ts` — forced-JSON-mode HTTP client, classifies 429 vs. other failures
- `queue.ts` — wires the above into a BullMQ `Worker`; `geminiBackoffStrategy` is the 5s/15s/45s/120s-then-park ladder
- `enqueue.ts` — typed helpers for adding entailment/banned-claim/rubric jobs
- `run.ts` — the standalone worker process (`npm run worker:gemini-quota`)

**`src/lib/pacificQuotaDay.ts`** — DST-aware Pacific-midnight computation
(the thing v3 of the plan got wrong by hardcoding a fixed UTC offset).

## Not built yet

- Claude generation + self-critique (plan §5 Steps 2–3)
- Deterministic checks, including the corpus uniqueness/thinness gate (plan §5 Step 4, §4a)
- Astro site + Cloudflare Worker proxy
- BDIP/Supabase sync jobs
- Editorial queue / admin UI

## A note on this repo's tests

Every claim in this README about the rate-limit worker's behavior —
the RPM cap holding under concurrency, the daily budget resetting on
the correct Pacific day, the 429 ladder's exact delays, the circuit
breaker tripping at the threshold and not before, 429s never counting
toward it — is covered by a test in `test/` that runs against real
Postgres and Redis, not a mock. Run `npm test` before trusting any
change to this worker.
