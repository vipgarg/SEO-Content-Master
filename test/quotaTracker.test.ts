import "dotenv/config";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QuotaTracker } from "../src/workers/gemini/quotaTracker.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe("QuotaTracker", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM api_quota_ledger WHERE provider = 'gemini-test'");
  });

  it("allows requests up to the daily cap, then blocks", async () => {
    const tracker = new QuotaTracker({ pool, provider: "gemini-test", model: "flash", dailyCap: 3 });
    const now = new Date("2026-08-27T12:00:00Z");
    expect((await tracker.reserveRequest(now)).allowed).toBe(true);
    expect((await tracker.reserveRequest(now)).allowed).toBe(true);
    expect((await tracker.reserveRequest(now)).allowed).toBe(true);
    const fourth = await tracker.reserveRequest(now);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.resumeAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("tracks separate budgets per Pacific quota day", async () => {
    const tracker = new QuotaTracker({ pool, provider: "gemini-test", model: "flash", dailyCap: 1 });
    const day1 = new Date("2026-08-27T20:00:00Z"); // afternoon PDT, well inside Aug 27 PT
    const day2 = new Date("2026-08-28T20:00:00Z"); // next Pacific day
    expect((await tracker.reserveRequest(day1)).allowed).toBe(true);
    expect((await tracker.reserveRequest(day1)).allowed).toBe(false);
    // A new Pacific day should have its own fresh budget.
    expect((await tracker.reserveRequest(day2)).allowed).toBe(true);
  });

  it("does not double-count under concurrent reservation attempts (row lock holds)", async () => {
    const tracker = new QuotaTracker({ pool, provider: "gemini-test", model: "flash", dailyCap: 5 });
    const now = new Date("2026-08-27T12:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => tracker.reserveRequest(now)),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5);
  });

  it("records throttle counts without affecting the request budget", async () => {
    const tracker = new QuotaTracker({ pool, provider: "gemini-test", model: "flash", dailyCap: 5 });
    const now = new Date("2026-08-27T12:00:00Z");
    await tracker.recordThrottle(now);
    await tracker.recordThrottle(now);
    const { rows } = await pool.query(
      `SELECT requests_used, throttled_count FROM api_quota_ledger
       WHERE provider = 'gemini-test' AND model = 'flash' AND quota_date = '2026-08-27'`,
    );
    expect(rows[0].throttled_count).toBe(2);
    expect(rows[0].requests_used).toBe(0);
  });
});
