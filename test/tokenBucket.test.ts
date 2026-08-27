import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TokenBucket } from "../src/workers/gemini/tokenBucket.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(() => {
  redis.disconnect();
});

describe("TokenBucket", () => {
  const key = "test:tokenbucket";

  beforeEach(async () => {
    await redis.del(key);
  });

  it("allows exactly `capacity` requests in a burst, then rejects", async () => {
    const bucket = new TokenBucket({ redis, key, capacity: 3, periodMs: 60_000 });
    const now = Date.now();
    expect(await bucket.tryConsume(now)).toBe(true);
    expect(await bucket.tryConsume(now)).toBe(true);
    expect(await bucket.tryConsume(now)).toBe(true);
    expect(await bucket.tryConsume(now)).toBe(false);
  });

  it("refills continuously over the period, not in a step", async () => {
    const bucket = new TokenBucket({ redis, key, capacity: 6, periodMs: 60_000 });
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) expect(await bucket.tryConsume(t0)).toBe(true);
    expect(await bucket.tryConsume(t0)).toBe(false);

    // Half the period later, roughly half the bucket should have refilled.
    const halfway = t0 + 30_000;
    let allowed = 0;
    for (let i = 0; i < 6; i++) {
      if (await bucket.tryConsume(halfway)) allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(2);
    expect(allowed).toBeLessThanOrEqual(4);
  });

  it("never allows more than `capacity` requests inside any rolling period, even under concurrency", async () => {
    const bucket = new TokenBucket({ redis, key, capacity: 8, periodMs: 60_000 });
    const now = Date.now();
    // Fire 40 concurrent attempts at the same instant — the Lua script
    // must serialize these so at most 8 succeed, not more (the whole
    // point of doing this atomically in Redis rather than read-then-write
    // in application code).
    const results = await Promise.all(
      Array.from({ length: 40 }, () => bucket.tryConsume(now)),
    );
    const allowedCount = results.filter(Boolean).length;
    expect(allowedCount).toBe(8);
  });

  it("reports msUntilNextToken as 0 when tokens are available, >0 when exhausted", async () => {
    const bucket = new TokenBucket({ redis, key, capacity: 1, periodMs: 60_000 });
    const now = Date.now();
    expect(await bucket.msUntilNextToken(now)).toBe(0);
    await bucket.tryConsume(now);
    const wait = await bucket.msUntilNextToken(now);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60_000);
  });
});
