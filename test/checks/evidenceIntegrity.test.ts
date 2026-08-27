import { describe, expect, it } from "vitest";
import { checkEvidenceIntegrity } from "../../src/checks/evidenceIntegrity.js";
import type { ClaimRow, EvidenceRow, FreshnessRule } from "../../src/checks/types.js";

const NOW = new Date("2026-08-27T12:00:00Z");
const DAY = 24 * 3600 * 1000;

function evidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 1,
    entityType: "edition",
    entityId: 1,
    attribute: "page_count",
    valueText: null,
    valueNum: 812,
    valueDate: null,
    valueBool: null,
    sourceType: "publisher",
    publishable: true,
    retrievedAt: NOW,
    supersededBy: null,
    deletedAt: null,
    ...overrides,
  };
}

function claim(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 1,
    blockId: 1,
    claimKey: "c1",
    claimText: "812 pages",
    claimType: "numeric",
    evidenceIds: [1],
    ...overrides,
  };
}

const rules = new Map<string, FreshnessRule>([
  ["page_count", { maxAgeMs: 365 * DAY, requiredSource: "publisher" }],
  ["syllabus_coverage", { maxAgeMs: 90 * DAY, requiredSource: "official_exam_body" }],
]);

describe("checkEvidenceIntegrity", () => {
  it("passes clean, fresh, correctly-sourced evidence", () => {
    const c = claim();
    const ev = new Map([[1, evidence()]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)).toEqual([]);
  });

  it("fails when the referenced evidence id does not exist", () => {
    const c = claim({ evidenceIds: [999] });
    expect(checkEvidenceIntegrity(c, new Map(), rules, NOW)[0]?.code).toBe("evidence_not_found");
  });

  it("fails soft-deleted evidence", () => {
    const c = claim();
    const ev = new Map([[1, evidence({ deletedAt: NOW })]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)[0]?.code).toBe("evidence_deleted");
  });

  it("fails superseded evidence", () => {
    const c = claim();
    const ev = new Map([[1, evidence({ supersededBy: 42 })]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)[0]?.code).toBe("evidence_superseded");
  });

  it("fails non-publishable evidence", () => {
    const c = claim();
    const ev = new Map([[1, evidence({ publishable: false })]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)[0]?.code).toBe("evidence_not_publishable");
  });

  it("fails stale evidence beyond the attribute's freshness window", () => {
    const c = claim();
    const ev = new Map([[1, evidence({ retrievedAt: new Date(NOW.getTime() - 400 * DAY) })]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)[0]?.code).toBe("evidence_stale");
  });

  it("passes evidence just inside the freshness window", () => {
    const c = claim();
    const ev = new Map([[1, evidence({ retrievedAt: new Date(NOW.getTime() - 364 * DAY) })]]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)).toEqual([]);
  });

  it("fails when required_source doesn't match — the gap closed relative to v3's evidence-pack query", () => {
    const c = claim({
      claimText: "covers the full syllabus",
      claimType: "categorical",
    });
    const ev = new Map([
      [1, evidence({ attribute: "syllabus_coverage", sourceType: "first_party", retrievedAt: NOW })],
    ]);
    const failures = checkEvidenceIntegrity(c, ev, rules, NOW);
    expect(failures[0]?.code).toBe("evidence_wrong_source");
  });

  it("passes when required_source matches", () => {
    const c = claim({ claimText: "covers the full syllabus", claimType: "categorical" });
    const ev = new Map([
      [1, evidence({ attribute: "syllabus_coverage", sourceType: "official_exam_body", retrievedAt: NOW })],
    ]);
    expect(checkEvidenceIntegrity(c, ev, rules, NOW)).toEqual([]);
  });

  it("falls back to the 90-day default when an attribute has no explicit freshness rule", () => {
    const c = claim({ claimType: "entity" });
    const ev = new Map([
      [1, evidence({ attribute: "some_unlisted_attribute", valueText: "x", retrievedAt: new Date(NOW.getTime() - 100 * DAY) })],
    ]);
    expect(checkEvidenceIntegrity(c, ev, new Map(), NOW)[0]?.code).toBe("evidence_stale");
  });

  it("is a no-op for descriptive claims", () => {
    const c = claim({ claimType: "descriptive", evidenceIds: [] });
    expect(checkEvidenceIntegrity(c, new Map(), rules, NOW)).toEqual([]);
  });
});
