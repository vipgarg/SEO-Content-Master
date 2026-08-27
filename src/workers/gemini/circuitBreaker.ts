// Circuit breaker (plan §4): "5 consecutive non-429 errors → pause the
// queue and alert. Prevents burning quota on a broken prompt."
//
// A 429 is a quota signal, not a verification failure or a broken
// prompt — it must never count toward this breaker (that's the
// QuotaTracker/backoff ladder's job instead).

import type { Redis } from "ioredis";

export type AlertFn = (message: string, meta: Record<string, unknown>) => void;

export interface CircuitBreakerOptions {
  redis: Redis;
  key: string;
  threshold: number;
  onTrip: AlertFn;
}

export class CircuitBreaker {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly threshold: number;
  private readonly onTrip: AlertFn;

  constructor(opts: CircuitBreakerOptions) {
    this.redis = opts.redis;
    this.key = opts.key;
    this.threshold = opts.threshold;
    this.onTrip = opts.onTrip;
  }

  /** Call after a successful (non-429, non-error) verification call. */
  async recordSuccess(): Promise<void> {
    await this.redis.set(this.key, "0");
  }

  /**
   * Call after a non-429 failure. Returns true if this call tripped the
   * breaker (i.e. the caller should pause the queue now).
   */
  async recordFailure(context: Record<string, unknown> = {}): Promise<boolean> {
    const count = await this.redis.incr(this.key);
    if (count >= this.threshold) {
      this.onTrip(
        `Circuit breaker tripped: ${count} consecutive non-429 Gemini errors`,
        context,
      );
      return true;
    }
    return false;
  }

  async currentCount(): Promise<number> {
    const value = await this.redis.get(this.key);
    return value ? Number.parseInt(value, 10) : 0;
  }

  async reset(): Promise<void> {
    await this.redis.set(this.key, "0");
  }
}
