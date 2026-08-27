// End-to-end integration test: runs the real gemini_quota worker
// (real BullMQ, real Redis, real Postgres) with only the outbound
// Gemini HTTP call mocked out. Proves the pieces wired together in
// queue.ts actually behave the way the unit tests of the individual
// pieces (tokenBucket/quotaTracker/circuitBreaker) claim in isolation.

import "dotenv/config";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiCallResult } from "../src/workers/gemini/geminiClient.js";
import { GeminiApiError, GeminiRateLimitError } from "../src/workers/gemini/geminiClient.js";
import { createGeminiWorker } from "../src/workers/gemini/queue.js";
import type { EntailmentResult } from "../src/workers/gemini/types.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

// Random base rather than a fixed constant: a fixed base collides with
// leftover rows from a previous run that wasn't cleaned up (this suite
// only deletes its own rows in afterAll, which a killed/crashed run
// would skip). Random keeps reruns independent of that.
let pageIdCounter = 1_000_000 + Math.floor(Math.random() * 8_000_000);
async function makeTestPage(): Promise<number> {
  const n = pageIdCounter++;
  const slug = `test-page-${n}-${Date.now()}`;
  // primary_entity_id varies per row — pages carries a unique index on
  // (primary_entity_type, primary_entity_id, page_type, secondary_entity_id),
  // so a fixed entity id here would collide across test pages.
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pages (page_type, slug, primary_entity_type, primary_entity_id)
     VALUES ('book', $1, 'work', $2) RETURNING id`,
    [slug, n],
  );
  return rows[0]!.id;
}

async function cleanupRedisKeys(): Promise<void> {
  const keys = await redis.keys("bull:gemini-verification:*");
  if (keys.length) await redis.del(...keys);
  await redis.del("gemini:tokenbucket", "gemini:circuitbreaker");
}

describe("gemini_quota worker (integration)", () => {
  beforeEach(async () => {
    await cleanupRedisKeys();
  });

  afterEach(async () => {
    await cleanupRedisKeys();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM pages WHERE slug LIKE 'test-page-%'");
    await pool.end();
    redis.disconnect();
  });

  it("processes a successful entailment job and logs it to verification_runs", async () => {
    const pageId = await makeTestPage();
    const geminiCall = vi.fn(
      async (): Promise<GeminiCallResult<EntailmentResult>> => ({
        data: { results: [{ id: "c1", verdict: "entailed", confidence: 0.95, reason: "matches" }] },
        promptTokens: 120,
        responseTokens: 40,
      }),
    );

    const { queue, worker } = createGeminiWorker({
      redis,
      pool,
      apiKey: "test-key",
      rpmLimit: 8,
      rpdLimit: 1200,
      circuitBreakerThreshold: 5,
      onAlert: vi.fn(),
      models: { entailment: "gemini-flash-latest", banned_claim: "x", rubric: "x" },
      geminiCall: geminiCall as never,
    });

    try {
      const job = await queue.add(
        "entailment",
        {
          stage: "entailment",
          pageId,
          items: [{ id: "c1", claim: "812 pages", evidence: [{ id: 1, source_type: "publisher", text: "Pages: 812" }] }],
        },
        { attempts: 5, backoff: { type: "gemini-429-then-park" } },
      );

      await pollUntilFinished(queue, job.id!);

      expect(geminiCall).toHaveBeenCalledTimes(1);

      const { rows } = await pool.query(
        `SELECT stage, passed, provider, claims_checked, request_tokens, response_tokens
         FROM verification_runs WHERE page_id = $1`,
        [pageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].stage).toBe("entailment");
      expect(rows[0].passed).toBe(true);
      expect(rows[0].provider).toBe("gemini");
      expect(rows[0].claims_checked).toBe(1);
      expect(rows[0].request_tokens).toBe(120);
      expect(rows[0].response_tokens).toBe(40);
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 15000);

  it("does not trip the circuit breaker on 429s, and records the throttle", async () => {
    const pageId = await makeTestPage();
    let calls = 0;
    const geminiCall = vi.fn(async (): Promise<GeminiCallResult<EntailmentResult>> => {
      calls++;
      throw new GeminiRateLimitError();
    });

    const onAlert = vi.fn();
    const { queue, worker, circuitBreaker } = createGeminiWorker({
      redis,
      pool,
      apiKey: "test-key",
      rpmLimit: 8,
      rpdLimit: 1200,
      circuitBreakerThreshold: 3,
      onAlert,
      models: { entailment: "gemini-flash-latest", banned_claim: "x", rubric: "x" },
      geminiCall: geminiCall as never,
    });

    try {
      await queue.add(
        "entailment",
        { stage: "entailment", pageId, items: [{ id: "c1", claim: "x", evidence: [] }] },
        { attempts: 5, backoff: { type: "gemini-429-then-park" } },
      );

      // Give the worker time to make (and fail) its first attempt —
      // the retry itself will be delayed 5s by the ladder, so we only
      // need to observe the first attempt within this test's window.
      await waitFor(() => calls >= 1, 5000);

      expect(await circuitBreaker.currentCount()).toBe(0);
      expect(onAlert).not.toHaveBeenCalled();

      const { rows } = await pool.query(
        `SELECT http_status, passed FROM verification_runs WHERE page_id = $1`,
        [pageId],
      );
      expect(rows.some((r) => r.http_status === 429 && r.passed === false)).toBe(true);
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 15000);

  it("trips the circuit breaker and pauses the queue after threshold consecutive non-429 failures", async () => {
    const geminiCall = vi.fn(async (): Promise<GeminiCallResult<EntailmentResult>> => {
      throw new GeminiApiError("malformed JSON from Gemini");
    });
    const onAlert = vi.fn();

    const { queue, worker } = createGeminiWorker({
      redis,
      pool,
      apiKey: "test-key",
      rpmLimit: 8,
      rpdLimit: 1200,
      circuitBreakerThreshold: 3,
      onAlert,
      models: { entailment: "gemini-flash-latest", banned_claim: "x", rubric: "x" },
      geminiCall: geminiCall as never,
    });

    try {
      // Each job fails once (non-429) and only needs 1 attempt to count
      // toward the breaker — use 3 separate pages so we don't wait on
      // the per-job backoff ladder between retries.
      for (let i = 0; i < 3; i++) {
        const pageId = await makeTestPage();
        await queue.add(
          "entailment",
          { stage: "entailment", pageId, items: [{ id: "c1", claim: "x", evidence: [] }] },
          { attempts: 1 },
        );
      }

      await waitFor(() => onAlert.mock.calls.length >= 1, 8000);
      expect(await queue.isPaused()).toBe(true);
    } finally {
      await queue.resume();
      await worker.close();
      await queue.close();
    }
  }, 15000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pollUntilFinished(
  queue: import("bullmq").Queue,
  jobId: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    const state = await job?.getState();
    if (state === "completed" || state === "failed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("pollUntilFinished timed out");
}
