// Entrypoint: `npm run worker:gemini-quota`.
//
// Starts the gemini_quota worker (plan §4) as a standalone long-running
// process. This is the only process in the system that should hold a
// GEMINI_API_KEY — every verification call flows through here so the
// rate limiter, daily budget, and circuit breaker are enforced exactly
// once, in exactly one place.

import "dotenv/config";
import { Redis } from "ioredis";
import pino from "pino";
import { getPool } from "../../db/pool.js";
import { config } from "../../lib/config.js";
import { createGeminiWorker } from "./queue.js";

const logger = pino({ level: config.logLevel(), name: "gemini-quota-worker" });

async function main(): Promise<void> {
  const pool = getPool();
  const redis = new Redis(config.redisUrl(), { maxRetriesPerRequest: null });

  const { worker, queue } = createGeminiWorker({
    redis,
    pool,
    apiKey: config.gemini.apiKey(),
    rpmLimit: config.gemini.rpmLimit,
    rpdLimit: config.gemini.rpdLimit,
    circuitBreakerThreshold: config.circuitBreakerThreshold,
    onAlert: (message, meta) => {
      // TODO: wire to whatever paging/alerting channel this project
      // uses (Slack, email) once one exists. Logging loudly for now so
      // a tripped breaker is never silent.
      logger.error({ meta }, message);
    },
    models: {
      entailment: "gemini-flash-latest",
      banned_claim: "gemini-flash-lite-latest",
      rubric: "gemini-flash-latest",
    },
  });

  worker.on("failed", (job, err) => {
    logger.warn(
      { jobId: job?.id, pageId: job?.data.pageId, stage: job?.data.stage, err: err.message },
      "verification job failed",
    );
  });
  worker.on("error", (err) => {
    logger.error({ err: err.message }, "worker error");
  });

  logger.info(
    { rpmLimit: config.gemini.rpmLimit, rpdLimit: config.gemini.rpdLimit },
    "gemini_quota worker started",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down gemini_quota worker");
    await worker.close();
    await queue.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "gemini_quota worker failed to start");
  process.exit(1);
});
