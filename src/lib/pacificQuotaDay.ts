// Gemini's free-tier daily quota resets at midnight Pacific time — and
// Pacific is UTC-7 (PDT) roughly mid-March to early November, UTC-8
// (PST) otherwise. v3 of the generation plan hardcoded this as a fixed
// "08:00 UTC", which is wrong for 8 months of the year; this module is
// the fix (see docs/generation-plan-v3.1.md §2/§4).
//
// Everything here is computed via the IANA `America/Los_Angeles` zone
// through luxon, which carries the DST rules, rather than any hardcoded
// UTC offset.

import { DateTime } from "luxon";

const PACIFIC_ZONE = "America/Los_Angeles";

/**
 * The Pacific-calendar-date bucket a request at `now` belongs to, as
 * "YYYY-MM-DD" — this is the `quota_date` key used in api_quota_ledger.
 */
export function currentPacificQuotaDate(now: Date = new Date()): string {
  const iso = DateTime.fromJSDate(now, { zone: PACIFIC_ZONE }).toISODate();
  if (!iso) throw new Error(`Could not compute Pacific date for ${now.toISOString()}`);
  return iso;
}

/** Milliseconds from `now` until the next Pacific-midnight quota reset. */
export function msUntilNextPacificMidnight(now: Date = new Date()): number {
  const nowPT = DateTime.fromJSDate(now, { zone: PACIFIC_ZONE });
  const nextMidnightPT = nowPT.plus({ days: 1 }).startOf("day");
  return Math.max(0, nextMidnightPT.diff(nowPT).toMillis());
}
