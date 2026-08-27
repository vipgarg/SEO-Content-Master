import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in.`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

export const config = {
  databaseUrl: () => requireEnv("DATABASE_URL"),
  redisUrl: () => process.env.REDIS_URL ?? "redis://localhost:6379",

  gemini: {
    apiKey: () => requireEnv("GEMINI_API_KEY"),
    projectId: () => process.env.GEMINI_PROJECT_ID ?? "",
    // Headroom below the live free-tier caps — re-verify the live caps
    // before changing these. See docs/generation-plan-v3.1.md §2/§4.
    rpmLimit: intEnv("GEMINI_RPM_LIMIT", 8),
    rpdLimit: intEnv("GEMINI_RPD_LIMIT", 1200),
  },

  // 429 backoff ladder, ms — plan §4. After this many escalating
  // attempts, the job is parked (delayed until next Pacific-midnight
  // quota reset) rather than marked failed.
  geminiBackoffMs: [5_000, 15_000, 45_000, 120_000] as const,

  // Circuit breaker: this many consecutive *non-429* failures pauses
  // the queue and alerts, rather than continuing to burn quota against
  // a broken prompt. Plan §4.
  circuitBreakerThreshold: 5,

  logLevel: () => process.env.LOG_LEVEL ?? "info",
};
