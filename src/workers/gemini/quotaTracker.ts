// Daily quota tracker against api_quota_ledger (schema §A.7). Plan §4:
// "Daily quota tracker in Postgres, resetting at [Pacific midnight].
// When the daily budget is consumed, the queue pauses and resumes next
// window rather than failing jobs."

import type { Pool } from "pg";
import { currentPacificQuotaDate, msUntilNextPacificMidnight } from "../../lib/pacificQuotaDay.js";

export interface QuotaTrackerOptions {
  pool: Pool;
  provider: string; // 'gemini'
  model: string; // 'gemini-flash', 'gemini-flash-lite'
  dailyCap: number;
}

export class QuotaTracker {
  private readonly pool: Pool;
  private readonly provider: string;
  private readonly model: string;
  private readonly dailyCap: number;

  constructor(opts: QuotaTrackerOptions) {
    this.pool = opts.pool;
    this.provider = opts.provider;
    this.model = opts.model;
    this.dailyCap = opts.dailyCap;
  }

  /**
   * Atomically checks remaining budget and reserves one request if
   * available. Returns { allowed: true } and increments requests_used,
   * or { allowed: false, resumeAt } if today's cap is spent.
   */
  async reserveRequest(now: Date = new Date()): Promise<
    { allowed: true } | { allowed: false; resumeAt: Date }
  > {
    const quotaDate = currentPacificQuotaDate(now);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Upsert the row for today, then lock it for the read-check-increment.
      await client.query(
        `INSERT INTO api_quota_ledger (provider, model, quota_date, requests_cap)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, model, quota_date) DO NOTHING`,
        [this.provider, this.model, quotaDate, this.dailyCap],
      );
      const { rows } = await client.query<{ requests_used: number; requests_cap: number }>(
        `SELECT requests_used, requests_cap FROM api_quota_ledger
         WHERE provider = $1 AND model = $2 AND quota_date = $3
         FOR UPDATE`,
        [this.provider, this.model, quotaDate],
      );
      const row = rows[0];
      if (!row || row.requests_used >= row.requests_cap) {
        await client.query("ROLLBACK");
        return { allowed: false, resumeAt: nextPacificMidnight(now) };
      }
      await client.query(
        `UPDATE api_quota_ledger SET requests_used = requests_used + 1
         WHERE provider = $1 AND model = $2 AND quota_date = $3`,
        [this.provider, this.model, quotaDate],
      );
      await client.query("COMMIT");
      return { allowed: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Record a 429 against today's ledger row, for observability. */
  async recordThrottle(now: Date = new Date()): Promise<void> {
    const quotaDate = currentPacificQuotaDate(now);
    await this.pool.query(
      `INSERT INTO api_quota_ledger (provider, model, quota_date, requests_cap, throttled_count)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (provider, model, quota_date)
       DO UPDATE SET throttled_count = api_quota_ledger.throttled_count + 1`,
      [this.provider, this.model, quotaDate, this.dailyCap],
    );
  }
}

function nextPacificMidnight(now: Date): Date {
  return new Date(now.getTime() + msUntilNextPacificMidnight(now));
}
