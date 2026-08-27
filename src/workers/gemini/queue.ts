// The gemini_quota worker (plan §4): every Gemini call in the system
// flows through this queue, so the RPM/RPD caps, 429 ladder-then-park,
// and circuit breaker are enforced in exactly one place rather than
// re-implemented per call site.

import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { TokenBucket } from "./tokenBucket.js";
import { QuotaTracker } from "./quotaTracker.js";
import { CircuitBreaker, type AlertFn } from "./circuitBreaker.js";
import {
  callGeminiJson,
  GeminiRateLimitError,
  GeminiApiError,
  type GeminiCallResult,
} from "./geminiClient.js";
import { msUntilNextPacificMidnight } from "../../lib/pacificQuotaDay.js";
import type {
  GeminiJobData,
  EntailmentJobData,
  BannedClaimJobData,
  RubricJobData,
} from "./types.js";

export const GEMINI_QUEUE_NAME = "gemini-verification";

// 429 backoff ladder (plan §4): 5s, 15s, 45s, 120s, then park until the
// next Pacific-midnight quota reset instead of failing the job.
const BACKOFF_LADDER_MS = [5_000, 15_000, 45_000, 120_000] as const;
export const GEMINI_BACKOFF_TYPE = "gemini-429-then-park";

// High enough that the ladder-then-park cycle can repeat for a very
// long time (each park is up to ~24h) without BullMQ giving up and
// marking the job permanently failed — parking is a wait, not a failure.
const MAX_ATTEMPTS = 1000;

/**
 * Pure backoff logic, exported separately so the ladder-then-park
 * behavior can be unit tested without waiting on real BullMQ delays.
 * Signature matches BullMQ's BackoffStrategy contract.
 */
export function geminiBackoffStrategy(
  attemptsMade: number,
  _type: string | undefined,
  err: Error | undefined,
): number {
  if (err instanceof GeminiRateLimitError) {
    const idx = attemptsMade - 1;
    const rung = idx >= 0 ? BACKOFF_LADDER_MS[idx] : undefined;
    if (rung !== undefined) return rung;
    // Ladder exhausted: park until the next Pacific-midnight quota
    // reset rather than continuing to hammer a 429.
    return msUntilNextPacificMidnight();
  }
  // Non-429 failures: short fixed delay before the next attempt. The
  // circuit breaker (tripped in the processor) is what actually stops a
  // broken prompt from burning quota — this is just spacing between
  // attempts while it does.
  return BACKOFF_LADDER_MS[0];
}

export function defaultGeminiJobOptions(): JobsOptions {
  return {
    attempts: MAX_ATTEMPTS,
    backoff: { type: GEMINI_BACKOFF_TYPE },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  };
}

export interface GeminiModels {
  entailment: string;
  banned_claim: string;
  rubric: string;
}

export interface GeminiWorkerDeps {
  redis: Redis;
  pool: Pool;
  apiKey: string;
  rpmLimit: number;
  rpdLimit: number;
  circuitBreakerThreshold: number;
  onAlert: AlertFn;
  models: GeminiModels;
  /** Injectable for tests — defaults to the real HTTP client. */
  geminiCall?: typeof callGeminiJson;
}

interface PromptSpec {
  model: string;
  system: string;
  prompt: string;
}

// Prompt construction per plan §5 Steps 5–7. Kept intentionally plain —
// this is the contract with Gemini, not a place for cleverness. Each
// system prompt reiterates the one rule that matters for that stage.

function buildEntailmentPrompt(data: EntailmentJobData, model: string): PromptSpec {
  return {
    model,
    system:
      "You judge whether evidence supports a claim. You see each claim " +
      "with only its own cited evidence — no page title, no book name, " +
      "no surrounding prose. Judge support, not plausibility. " +
      'Respond with JSON only: {"results":[{"id":"c1","verdict":"entailed|partially|not_entailed|contradicted","confidence":0.0,"reason":"..."}]}',
    prompt: JSON.stringify({
      task: "For each item, decide whether the evidence supports the claim.",
      items: data.items,
    }),
  };
}

function buildBannedClaimPrompt(data: BannedClaimJobData, model: string): PromptSpec {
  return {
    model,
    system:
      "Scan the text for: exam outcome guarantees, medical/legal/financial " +
      "advice, syllabus claims without an official-exam-body source, " +
      "competitor disparagement, or any Amazon-derived figure (ratings, " +
      "review counts, sales rank). " +
      'Respond with JSON only: {"hit":true|false,"rule":"...","offending_span":"..."}. ' +
      'If no hit, respond {"hit":false}.',
    prompt: data.renderedText,
  };
}

function buildRubricPrompt(data: RubricJobData, model: string): PromptSpec {
  return {
    model,
    system:
      "Score this page on observable properties only. This is advisory " +
      "routing, not a publication gate. " +
      'Respond with JSON only: {"score":0-100,"answers_query_in_first_100_words":true|false,' +
      '"has_information_beyond_metadata":true|false,"filler_sections":["..."]}',
    prompt: JSON.stringify({
      renderedText: data.renderedText,
      metaTitle: data.metaTitle,
      metaDescription: data.metaDescription,
    }),
  };
}

function buildPrompt(data: GeminiJobData, models: GeminiModels): PromptSpec {
  switch (data.stage) {
    case "entailment":
      return buildEntailmentPrompt(data, models.entailment);
    case "banned_claim":
      return buildBannedClaimPrompt(data, models.banned_claim);
    case "rubric":
      return buildRubricPrompt(data, models.rubric);
  }
}

async function logVerificationRun(
  pool: Pool,
  data: GeminiJobData,
  model: string,
  attempt: number,
  outcome:
    | { passed: true; latencyMs: number; promptTokens?: number; responseTokens?: number }
    | { passed: false; latencyMs: number; failureReason: string; httpStatus?: number },
): Promise<void> {
  const claimsChecked = data.stage === "entailment" ? data.items.length : null;
  await pool.query(
    `INSERT INTO verification_runs
       (page_id, stage, model, provider, claims_checked, passed, failure_reason,
        request_tokens, response_tokens, latency_ms, http_status, attempt)
     VALUES ($1,$2,$3,'gemini',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      data.pageId,
      data.stage,
      model,
      claimsChecked,
      outcome.passed,
      outcome.passed ? null : outcome.failureReason,
      outcome.passed ? (outcome.promptTokens ?? null) : null,
      outcome.passed ? (outcome.responseTokens ?? null) : null,
      outcome.latencyMs,
      outcome.passed ? null : (outcome.httpStatus ?? null),
      attempt,
    ],
  );
}

export function createGeminiWorker(deps: GeminiWorkerDeps): {
  queue: Queue<GeminiJobData>;
  worker: Worker<GeminiJobData>;
  tokenBucket: TokenBucket;
  quotaTracker: QuotaTracker;
  circuitBreaker: CircuitBreaker;
} {
  const queue = new Queue<GeminiJobData>(GEMINI_QUEUE_NAME, { connection: deps.redis });

  const tokenBucket = new TokenBucket({
    redis: deps.redis,
    key: "gemini:tokenbucket",
    capacity: deps.rpmLimit,
    periodMs: 60_000,
  });
  // One shared daily budget across all three stages — plan §4's 1,200
  // RPD cap is per-project, not per-model, so per-stage tracking here
  // would undercount how close we are to the real ceiling.
  const quotaTracker = new QuotaTracker({
    pool: deps.pool,
    provider: "gemini",
    model: "free-tier-shared",
    dailyCap: deps.rpdLimit,
  });
  const circuitBreaker = new CircuitBreaker({
    redis: deps.redis,
    key: "gemini:circuitbreaker",
    threshold: deps.circuitBreakerThreshold,
    onTrip: deps.onAlert,
  });
  const geminiCall = deps.geminiCall ?? callGeminiJson;

  const processor = async (job: Job<GeminiJobData>): Promise<unknown> => {
    const allowedLocally = await tokenBucket.tryConsume();
    if (!allowedLocally) {
      const waitMs = await tokenBucket.msUntilNextToken();
      await queue.rateLimit(waitMs);
      throw Worker.RateLimitError();
    }

    const reservation = await quotaTracker.reserveRequest();
    if (!reservation.allowed) {
      const waitMs = Math.max(reservation.resumeAt.getTime() - Date.now(), 1_000);
      await queue.rateLimit(waitMs);
      throw Worker.RateLimitError();
    }

    const { model, system, prompt } = buildPrompt(job.data, deps.models);
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();

    try {
      const result: GeminiCallResult<unknown> = await geminiCall({
        apiKey: deps.apiKey,
        model,
        systemInstruction: system,
        prompt,
      });
      await circuitBreaker.recordSuccess();
      await logVerificationRun(deps.pool, job.data, model, attempt, {
        passed: true,
        latencyMs: Date.now() - startedAt,
        promptTokens: result.promptTokens,
        responseTokens: result.responseTokens,
      });
      return result.data;
    } catch (err) {
      const latencyMs = Date.now() - startedAt;

      if (err instanceof GeminiRateLimitError) {
        await quotaTracker.recordThrottle();
        await logVerificationRun(deps.pool, job.data, model, attempt, {
          passed: false,
          latencyMs,
          failureReason: "429 rate limited",
          httpStatus: 429,
        });
        // A 429 is not a verification failure and must never trip the
        // circuit breaker — plan §4. Re-thrown as-is so the custom
        // backoff strategy below can apply the ladder-then-park delay.
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      const httpStatus = err instanceof GeminiApiError ? err.status : undefined;
      await logVerificationRun(deps.pool, job.data, model, attempt, {
        passed: false,
        latencyMs,
        failureReason: message,
        httpStatus,
      });

      const tripped = await circuitBreaker.recordFailure({
        pageId: job.data.pageId,
        stage: job.data.stage,
        error: message,
      });
      if (tripped) {
        await queue.pause();
      }
      throw err;
    }
  };

  const worker = new Worker<GeminiJobData>(GEMINI_QUEUE_NAME, processor, {
    connection: deps.redis,
    settings: { backoffStrategy: geminiBackoffStrategy },
  });

  return { queue, worker, tokenBucket, quotaTracker, circuitBreaker };
}
