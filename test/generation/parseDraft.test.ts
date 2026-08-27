import { describe, expect, it } from "vitest";
import { DraftValidationError, findUnknownEvidenceReferences, parseDraftPage } from "../../src/generation/parseDraft.js";

function validRawDraft(): unknown {
  return {
    meta_title: "Lucent GK 2025 Edition",
    meta_description: "A detailed review of the Lucent GK 2025 edition.",
    unsupported_flags: ["could not source MCQ count"],
    blocks: [
      {
        block_key: "b1",
        block_type: "paragraph",
        section: "overview",
        heading: "Overview",
        body: "The 2025 edition runs to 812 pages.",
        is_required: true,
        claims: [
          { claim_key: "c1", claim_text: "812 pages", claim_type: "numeric", evidence_ids: [1] },
        ],
      },
      {
        block_key: "b2",
        block_type: "paragraph",
        section: null,
        heading: null,
        body: "This is a great pick for beginners.",
        is_required: false,
        claims: [
          { claim_key: "c2", claim_text: "great pick for beginners", claim_type: "descriptive", evidence_ids: [] },
        ],
      },
    ],
  };
}

describe("parseDraftPage — happy path", () => {
  it("parses a well-formed draft", () => {
    const draft = parseDraftPage(validRawDraft());
    expect(draft.meta_title).toBe("Lucent GK 2025 Edition");
    expect(draft.blocks).toHaveLength(2);
    expect(draft.blocks[0]?.claims[0]?.claim_type).toBe("numeric");
    expect(draft.unsupported_flags).toEqual(["could not source MCQ count"]);
  });

  it("defaults unsupported_flags to an empty array when absent", () => {
    const raw = validRawDraft() as Record<string, unknown>;
    delete raw.unsupported_flags;
    const draft = parseDraftPage(raw);
    expect(draft.unsupported_flags).toEqual([]);
  });
});

describe("parseDraftPage — structural validation", () => {
  it("rejects a non-object", () => {
    expect(() => parseDraftPage("not an object")).toThrow(DraftValidationError);
    expect(() => parseDraftPage(null)).toThrow(DraftValidationError);
    expect(() => parseDraftPage([1, 2, 3])).toThrow(DraftValidationError);
  });

  it("rejects an empty blocks array", () => {
    const raw = { ...(validRawDraft() as Record<string, unknown>), blocks: [] };
    expect(() => parseDraftPage(raw)).toThrow(/blocks must be a non-empty array/);
  });

  it("rejects a missing meta_title", () => {
    const raw = validRawDraft() as Record<string, unknown>;
    delete raw.meta_title;
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DraftValidationError);
      expect((err as DraftValidationError).issues.join()).toContain("meta_title");
    }
  });

  it("rejects an invalid block_type", () => {
    const raw = validRawDraft() as { blocks: Array<Record<string, unknown>> };
    raw.blocks[0]!.block_type = "banner"; // not in the enum
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain("block_type");
    }
  });

  it("rejects an invalid claim_type", () => {
    const raw = validRawDraft() as { blocks: Array<{ claims: Array<Record<string, unknown>> }> };
    raw.blocks[0]!.claims[0]!.claim_type = "opinion"; // not in the enum
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain("claim_type");
    }
  });

  it("rejects duplicate block_key across the page", () => {
    const raw = validRawDraft() as { blocks: Array<Record<string, unknown>> };
    raw.blocks[1]!.block_key = "b1"; // duplicate
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain("duplicate block_key");
    }
  });

  it("rejects duplicate claim_key across the page, even across different blocks", () => {
    const raw = validRawDraft() as { blocks: Array<{ claims: Array<Record<string, unknown>> }> };
    raw.blocks[1]!.claims[0]!.claim_key = "c1"; // collides with block 1's claim
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain("duplicate claim_key");
    }
  });
});

describe("parseDraftPage — evidence-requirement enforcement", () => {
  it("rejects a numeric claim with zero evidence_ids", () => {
    const raw = validRawDraft() as { blocks: Array<{ claims: Array<Record<string, unknown>> }> };
    raw.blocks[0]!.claims[0]!.evidence_ids = [];
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain("requires at least one evidence id");
    }
  });

  it("allows a descriptive claim with zero evidence_ids", () => {
    // block 2's claim is already descriptive with [] — should parse fine, covered by happy-path test too.
    expect(() => parseDraftPage(validRawDraft())).not.toThrow();
  });

  it("rejects a categorical claim (e.g. a superlative) with zero evidence_ids", () => {
    const raw = validRawDraft() as { blocks: Array<{ claims: Array<Record<string, unknown>> }> };
    raw.blocks[0]!.claims[0]!.claim_type = "categorical";
    raw.blocks[0]!.claims[0]!.evidence_ids = [];
    try {
      parseDraftPage(raw);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DraftValidationError).issues.join()).toContain('claim_type "categorical" requires');
    }
  });
});

describe("findUnknownEvidenceReferences", () => {
  it("finds nothing when every cited evidence id is known", () => {
    const draft = parseDraftPage(validRawDraft());
    expect(findUnknownEvidenceReferences(draft, new Set([1]))).toEqual([]);
  });

  it("flags a claim citing an evidence id outside the known set", () => {
    const draft = parseDraftPage(validRawDraft());
    const problems = findUnknownEvidenceReferences(draft, new Set([999])); // evidence id 1 not known
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("evidence id 1");
  });
});
