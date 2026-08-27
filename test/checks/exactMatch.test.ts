import { describe, expect, it } from "vitest";
import { checkClaimExactMatch, claimRequiresEvidence } from "../../src/checks/exactMatch.js";
import type { ClaimRow, EvidenceRow } from "../../src/checks/types.js";

function evidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 1,
    entityType: "edition",
    entityId: 1,
    attribute: "page_count",
    valueText: null,
    valueNum: null,
    valueDate: null,
    valueBool: null,
    sourceType: "publisher",
    publishable: true,
    retrievedAt: new Date(),
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
    claimText: "",
    claimType: "numeric",
    evidenceIds: [1],
    ...overrides,
  };
}

describe("claimRequiresEvidence", () => {
  it("requires evidence for numeric/date/identifier/entity/categorical, not descriptive", () => {
    expect(claimRequiresEvidence("numeric")).toBe(true);
    expect(claimRequiresEvidence("date")).toBe(true);
    expect(claimRequiresEvidence("identifier")).toBe(true);
    expect(claimRequiresEvidence("entity")).toBe(true);
    expect(claimRequiresEvidence("categorical")).toBe(true);
    expect(claimRequiresEvidence("descriptive")).toBe(false);
  });
});

describe("checkClaimExactMatch — numeric", () => {
  it("passes when the evidence number appears in the claim text", () => {
    const c = claim({ claimText: "The 2025 edition runs to 812 pages.", claimType: "numeric" });
    const ev = new Map([[1, evidence({ id: 1, valueNum: 812 })]]);
    expect(checkClaimExactMatch(c, ev)).toEqual([]);
  });

  it("fails when no extracted number matches the evidence value", () => {
    const c = claim({ claimText: "The 2025 edition runs to 900 pages.", claimType: "numeric" });
    const ev = new Map([[1, evidence({ id: 1, valueNum: 812 })]]);
    const failures = checkClaimExactMatch(c, ev);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("numeric_mismatch");
  });

  it("fails with a distinct code when the claim has no number at all", () => {
    const c = claim({ claimText: "This book is excellent.", claimType: "numeric" });
    const ev = new Map([[1, evidence({ id: 1, valueNum: 812 })]]);
    expect(checkClaimExactMatch(c, ev)[0]?.code).toBe("no_number_in_text");
  });
});

describe("checkClaimExactMatch — date", () => {
  it("passes when the evidence date appears in the claim text in any supported format", () => {
    const c = claim({ claimText: "Published on 1 June 2025.", claimType: "date" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "published_on", valueDate: "2025-06-01" })]]);
    expect(checkClaimExactMatch(c, ev)).toEqual([]);
  });

  it("fails on a date mismatch", () => {
    const c = claim({ claimText: "Published on 1 June 2024.", claimType: "date" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "published_on", valueDate: "2025-06-01" })]]);
    expect(checkClaimExactMatch(c, ev)[0]?.code).toBe("date_mismatch");
  });
});

describe("checkClaimExactMatch — identifier", () => {
  it("passes on a normalized ISBN match despite different hyphenation", () => {
    const c = claim({ claimText: "ISBN 978-93-5476-123-4.", claimType: "identifier" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "isbn13", valueText: "9789354761234" })]]);
    expect(checkClaimExactMatch(c, ev)).toEqual([]);
  });

  it("fails on an identifier mismatch", () => {
    const c = claim({ claimText: "ISBN 9780000000000.", claimType: "identifier" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "isbn13", valueText: "9789354761234" })]]);
    expect(checkClaimExactMatch(c, ev)[0]?.code).toBe("identifier_mismatch");
  });
});

describe("checkClaimExactMatch — entity", () => {
  it("passes when the evidence name is a normalized substring of the claim", () => {
    const c = claim({ claimText: "Published by Arihant Publications Pvt. Ltd.", claimType: "entity" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "publisher_name", valueText: "Arihant Publications" })]]);
    expect(checkClaimExactMatch(c, ev)).toEqual([]);
  });

  it("fails when the claim names a different entity", () => {
    const c = claim({ claimText: "Published by Lucent Publications.", claimType: "entity" });
    const ev = new Map([[1, evidence({ id: 1, attribute: "publisher_name", valueText: "Arihant Publications" })]]);
    expect(checkClaimExactMatch(c, ev)[0]?.code).toBe("entity_mismatch");
  });
});

describe("checkClaimExactMatch — descriptive claims are exempt", () => {
  it("never fails, regardless of evidence", () => {
    const c = claim({ claimText: "This is a great book for beginners.", claimType: "descriptive", evidenceIds: [] });
    expect(checkClaimExactMatch(c, new Map())).toEqual([]);
  });
});

describe("checkClaimExactMatch — missing evidence", () => {
  it("fails a numeric claim with zero cited evidence ids", () => {
    const c = claim({ claimText: "812 pages.", claimType: "numeric", evidenceIds: [] });
    expect(checkClaimExactMatch(c, new Map())[0]?.code).toBe("missing_evidence");
  });

  it("silently skips comparison when the referenced evidence id isn't in the map (evidenceIntegrity's job to report)", () => {
    const c = claim({ claimText: "812 pages.", claimType: "numeric", evidenceIds: [999] });
    expect(checkClaimExactMatch(c, new Map())).toEqual([]);
  });
});
