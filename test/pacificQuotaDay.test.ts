import { describe, expect, it } from "vitest";
import { currentPacificQuotaDate, msUntilNextPacificMidnight } from "../src/lib/pacificQuotaDay.js";

describe("currentPacificQuotaDate", () => {
  it("returns the Pacific calendar date during PDT (summer)", () => {
    // 2026-08-27T06:59:00Z is 2026-08-26 23:59 PDT (UTC-7) — still the 26th in Pacific.
    expect(currentPacificQuotaDate(new Date("2026-08-27T06:59:00Z"))).toBe("2026-08-26");
    // One minute later it's Pacific midnight — the 27th.
    expect(currentPacificQuotaDate(new Date("2026-08-27T07:01:00Z"))).toBe("2026-08-27");
  });

  it("returns the Pacific calendar date during PST (winter)", () => {
    // 2026-01-15T07:59:00Z is 2026-01-14 23:59 PST (UTC-8) — still the 14th.
    expect(currentPacificQuotaDate(new Date("2026-01-15T07:59:00Z"))).toBe("2026-01-14");
    // One minute later it's Pacific midnight — the 15th. This is the
    // exact case v3's hardcoded "08:00 UTC" got right by accident (it's
    // only right in winter) — v3.1 fixes it to be right year-round.
    expect(currentPacificQuotaDate(new Date("2026-01-15T08:01:00Z"))).toBe("2026-01-15");
  });

  it("disagrees with a hardcoded 08:00 UTC boundary during PDT — this is the bug v3.1 fixes", () => {
    // At 07:30 UTC in August (PDT), Pacific midnight has already passed
    // (it passed at 07:00 UTC), so the quota day has already rolled
    // over to the 27th. A hardcoded "resets at 08:00 UTC" tracker would
    // incorrectly still think it's the 26th for another 30 minutes.
    const at0730UTC = new Date("2026-08-27T07:30:00Z");
    expect(currentPacificQuotaDate(at0730UTC)).toBe("2026-08-27");
  });
});

describe("msUntilNextPacificMidnight", () => {
  it("is zero-ish right at the boundary and ~24h just after", () => {
    const justAfterMidnightPT = new Date("2026-08-27T07:00:01.000Z"); // 00:00:01 PDT
    const ms = msUntilNextPacificMidnight(justAfterMidnightPT);
    expect(ms).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(ms).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("handles the PDT->PST fall-back transition (a 25-hour Pacific day) without going negative", () => {
    // 2026-11-01 is the US fall-back date. Just confirm the function
    // stays sane (positive, bounded) across the transition rather than
    // asserting an exact offset, since the transition instant itself
    // depends on the tz database.
    const beforeFallback = new Date("2026-11-01T06:00:00Z");
    const ms = msUntilNextPacificMidnight(beforeFallback);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(26 * 3600 * 1000);
  });
});
