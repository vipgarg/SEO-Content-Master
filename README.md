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

**`src/generation/`** — plan §5 Steps 1–3: assembling the evidence pack, drafting, self-critique. No `ANTHROPIC_API_KEY` was available while building this (Claude Pro's subscription and the pay-per-token Anthropic API are separate products/billing — see the session's own discussion of that if you want the detail); it's built and tested the same way the Gemini worker was before a `GEMINI_API_KEY` existed — real network call swapped for an injected mock at every test, ready to point at the real API the moment a key exists.

- `types.ts` — the structured JSON contract with Claude (blocks → claims → evidence_ids). v2 §7 was the intended source of truth for this shape and wasn't available, so this is inferred from `schema-v4.1.sql` plus plan §5 Step 2's prose — reconcile against v2 §7 once it exists, don't treat this as settled
- `claudeClient.ts` — thin Messages API client, forces structured output via `tool_choice` rather than hoping a text response parses as JSON
- `prompts.ts` — the draft and self-critique prompts, plus the JSON Schema for the forced tool call
- `parseDraft.ts` — defensive runtime validation of Claude's tool output: catches duplicate block/claim keys, a numeric/date/identifier/entity/categorical claim with no evidence_ids, and (`findUnknownEvidenceReferences`) a claim citing an evidence id that was never in the pack sent to the model
- `generateDraft.ts` — the two-call chain (draft → self-critique), same tool contract both times so the output is directly comparable
- `db.ts` — plan §5 Step 1's evidence-pack query (extended, like `checks/evidenceIntegrity.ts`, to enforce `required_source` — closing that gap at the point evidence is assembled, not just where it's later checked), brief loading, draft persistence (replaces a page's blocks/claims/claim_evidence and advances its status), and `runGeneration`, which gates on `min_evidence` and routes to `evidence_gaps` rather than ever calling Claude when there isn't enough

**A real bug found and fixed while wiring this up:** `pg` returns `BIGINT`/`BIGSERIAL` columns as JS strings, not numbers, by default — and every id in this schema is `BIGSERIAL`. `EvidencePackItem.id` was typed `number` everywhere but was actually a string at runtime; `findUnknownEvidenceReferences`' `Set.has()` lookup against Claude's real (genuine JSON number) tool-call output would have silently flagged every legitimate claim as a hallucinated evidence reference. Fixed at the root in `src/db/typeParsers.ts` — a global `pg` type-parser registration, not a patch at each call site — plus an explicit `::int[]` cast for the one aggregated-array case (a different OID, not covered by the scalar fix). Both are now regression-tested.

## Not built yet

- The Astro renderer that would actually compute `RenderedStructure` (H1/H2/FAQ/link counts) — `seoStructure.ts` takes it as an input today, deliberately renderer-agnostic until one exists
- Astro site + Cloudflare Worker proxy
- BDIP/Supabase sync jobs
- Editorial queue / admin UI
- The actual generation → checks → Gemini-verification pipeline wiring (each stage exists and is tested; nothing yet calls them in sequence end-to-end for a real page)

## A note on this repo's tests

Every claim in this README — the RPM cap holding under concurrency,
the daily budget resetting on the correct Pacific day, the 429
ladder's exact delays, the circuit breaker tripping at the threshold
and not before, 429s never counting toward it, every deterministic
check's pass/fail boundary, the DB loaders round-tripping real rows,
the draft/self-critique call chain, the evidence-pack id type fix —
is covered by a test in `test/` that runs against real Postgres and
Redis, not a mock (the one exception is Claude/Gemini's own HTTP call,
mocked at the client boundary in both worker and generation tests —
no paid API key exists in this environment). Run `npm test` before
trusting any change. Postgres/Redis need to be running locally first —
if `npm test` can't connect, that's the environment, not the tests
(`service postgresql start` / `redis-server --daemonize yes`).
