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

**`src/checks/`** — the deterministic checks pipeline (plan §5 Step 4,
§4a): every check that has to pass before a page is allowed to spend
any Gemini quota, running as pure functions over plain data plus one
thin Postgres-backed loader/persister (`db.ts`), same split as the
gemini worker.

- `textExtraction.ts` — number/date/ISBN extraction, entity normalization, sentence splitting, and the sentence-skeleton fingerprint §4a's ratio check is built on
- `evidenceIntegrity.ts` — every claim's cited evidence exists, is publishable, unexpired, not superseded, and (closing a gap from the schema review) sourced from the right `source_type` where `evidence_freshness_rules.required_source` demands one
- `exactMatch.ts` — numeric/date/identifier/entity/categorical claims must contain their cited evidence's value verbatim; `descriptive` claims are exempt
- `seoStructure.ts` — meta title/description length, H1/H2 counts, internal links, FAQ range (the FAQ range didn't exist in the schema until migration 013 — the plan required it as a hard check but v4 never gave `content_briefs` anywhere to store it)
- `bannedPhrases.ts` — regex scan for generic AI-filler phrasing (a starter list standing in for v2 §8d, which wasn't available)
- `shingling.ts` — w-shingle Jaccard similarity, the *exact*-duplicate check
- `thinContent.ts` — the §4a gate: templated-sentence ratio against the whole corpus's sentence skeletons (pooled, not pairwise — see migration 014's comment for why that's a fix relative to the schema as first written), metadata-only word count, corpus-relative information gain
- `runDeterministicChecks.ts` — orchestrates all of the above into one pass/fail report; routes claim/block-level failures to block regeneration and page-level failures (SEO structure, banned phrase, duplicate, thin content) separately, per the plan's "regenerate the offending block only, never the whole page"
- `db.ts` — loads a page's blocks/claims/evidence/corpus from Postgres, persists the result to `verification_runs` + `seo_audits`, and moves the page to `checks_passed` or `needs_review`

## Not built yet

- Claude generation + self-critique (plan §5 Steps 2–3)
- The Astro renderer that would actually compute `RenderedStructure` (H1/H2/FAQ/link counts) — `seoStructure.ts` takes it as an input today, deliberately renderer-agnostic until one exists
- Astro site + Cloudflare Worker proxy
- BDIP/Supabase sync jobs
- Editorial queue / admin UI

## A note on this repo's tests

Every claim in this README — the RPM cap holding under concurrency,
the daily budget resetting on the correct Pacific day, the 429
ladder's exact delays, the circuit breaker tripping at the threshold
and not before, 429s never counting toward it, every deterministic
check's pass/fail boundary, the DB loaders round-tripping real rows —
is covered by a test in `test/` that runs against real Postgres and
Redis, not a mock. Run `npm test` before trusting any change.
