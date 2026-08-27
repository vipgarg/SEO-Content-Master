import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/workers/gemini/circuitBreaker.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(() => {
  redis.disconnect();
});

describe("CircuitBreaker", () => {
  const key = "test:circuitbreaker";

  beforeEach(async () => {
    await redis.del(key);
  });

  it("trips exactly at the threshold, not before", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ redis, key, threshold: 5, onTrip });

    for (let i = 0; i < 4; i++) {
      const tripped = await breaker.recordFailure();
      expect(tripped).toBe(false);
    }
    expect(onTrip).not.toHaveBeenCalled();

    const fifthTripped = await breaker.recordFailure();
    expect(fifthTripped).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("resets the streak on success, so an isolated failure never trips it", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ redis, key, threshold: 5, onTrip });

    for (let i = 0; i < 4; i++) await breaker.recordFailure();
    await breaker.recordSuccess();
    expect(await breaker.currentCount()).toBe(0);

    for (let i = 0; i < 4; i++) {
      expect(await breaker.recordFailure()).toBe(false);
    }
    expect(onTrip).not.toHaveBeenCalled();
  });
});
