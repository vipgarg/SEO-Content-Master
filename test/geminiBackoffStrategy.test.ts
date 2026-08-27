import { describe, expect, it } from "vitest";
import { GeminiRateLimitError } from "../src/workers/gemini/geminiClient.js";
import { geminiBackoffStrategy } from "../src/workers/gemini/queue.js";

describe("geminiBackoffStrategy", () => {
  it("follows the 5s/15s/45s/120s ladder for consecutive 429s (plan §4)", () => {
    const err = new GeminiRateLimitError();
    expect(geminiBackoffStrategy(1, "gemini-429-then-park", err)).toBe(5_000);
    expect(geminiBackoffStrategy(2, "gemini-429-then-park", err)).toBe(15_000);
    expect(geminiBackoffStrategy(3, "gemini-429-then-park", err)).toBe(45_000);
    expect(geminiBackoffStrategy(4, "gemini-429-then-park", err)).toBe(120_000);
  });

  it("parks until the next Pacific-midnight reset once the ladder is exhausted", () => {
    const err = new GeminiRateLimitError();
    const delay = geminiBackoffStrategy(5, "gemini-429-then-park", err);
    // Should be a large delay (park), not another ladder rung, and
    // bounded by a Pacific day (never more than ~24h + DST slop).
    expect(delay).toBeGreaterThan(120_000);
    expect(delay).toBeLessThanOrEqual(25 * 3600 * 1000);

    const delayLater = geminiBackoffStrategy(50, "gemini-429-then-park", err);
    expect(delayLater).toBeGreaterThan(120_000);
  });

  it("never treats a non-429 error as a ladder/park case — a broken prompt gets a short spacing delay instead", () => {
    const err = new Error("malformed JSON from Gemini");
    expect(geminiBackoffStrategy(1, "gemini-429-then-park", err)).toBe(5_000);
    expect(geminiBackoffStrategy(6, "gemini-429-then-park", err)).toBe(5_000);
  });
});
