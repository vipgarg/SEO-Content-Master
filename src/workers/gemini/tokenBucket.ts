// Redis-backed token bucket limiter for the Gemini RPM ceiling
// (plan §4: "Token bucket limiter at 8 RPM ... 1,200 RPD").
//
// Backed by Redis (not in-process memory) so the limit is correct
// across multiple worker processes, not just within one. The
// check-and-decrement is a single Lua script so concurrent callers
// can't both observe "1 token left" and both consume it.

import type { Redis } from "ioredis";

const REFILL_SCRIPT = `
-- KEYS[1] = bucket key
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill period in ms (time to go from 0 to full)
-- ARGV[3] = now (ms, epoch)
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(data[1])
local updatedAt = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = now - updatedAt
if elapsed > 0 then
  local refill = elapsed * (capacity / period)
  tokens = math.min(capacity, tokens + refill)
  updatedAt = now
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'updated_at', updatedAt)
redis.call('PEXPIRE', key, period * 2)

return { allowed, tostring(tokens) }
`;

export interface TokenBucketOptions {
  redis: Redis;
  /** Redis key this bucket lives under. */
  key: string;
  /** Max requests per `periodMs` (e.g. 8 for "8 RPM"). */
  capacity: number;
  /** Window the capacity refills over, ms (e.g. 60_000 for per-minute). */
  periodMs: number;
}

export class TokenBucket {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly capacity: number;
  private readonly periodMs: number;

  constructor(opts: TokenBucketOptions) {
    this.redis = opts.redis;
    this.key = opts.key;
    this.capacity = opts.capacity;
    this.periodMs = opts.periodMs;
  }

  /** Atomically try to consume one token. Returns true if allowed. */
  async tryConsume(now: number = Date.now()): Promise<boolean> {
    const result = (await this.redis.eval(
      REFILL_SCRIPT,
      1,
      this.key,
      this.capacity,
      this.periodMs,
      now,
    )) as [number, string];
    return result[0] === 1;
  }

  /**
   * Ms to wait before a token is likely available. Not authoritative
   * (another caller can still win the race) — callers should re-check
   * with tryConsume after waiting, not assume success.
   */
  async msUntilNextToken(now: number = Date.now()): Promise<number> {
    const data = await this.redis.hmget(this.key, "tokens", "updated_at");
    const tokens = data[0] ? Number.parseFloat(data[0]) : this.capacity;
    if (tokens >= 1) return 0;
    const msPerToken = this.periodMs / this.capacity;
    const deficit = 1 - tokens;
    return Math.ceil(deficit * msPerToken);
  }
}
