import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "../../src/checks/runDeterministicChecks.js";
import type { EvidenceRow, PageDraft } from "../../src/checks/types.js";

const NOW = new Date("2026-08-27T12:00:00Z");

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

function goodPage(): PageDraft {
  return {
    pageId: 1,
    metaTitle: "Lucent GK 2025 Edition Review",
    metaDescription: "A detailed, evidence-backed review of the Lucent GK 2025 edition for competitive exam aspirants.",
    blocks: [
      { id: 1, blockKey: "b1", position: 1, blockType: "paragraph", heading: null, body: "The 2025 edition runs to 812 pages, restructured around speed drills rather than rote formula lists.", isRequired: true },
    ],
    claims: [
      { id: 1, blockId: 1, claimKey: "c1", claimText: "The 2025 edition runs to 812 pages.", claimType: "numeric", evidenceIds: [1] },
    ],
  };
}

const baseInput = {
  evidenceById: new Map([[1, evidence()]]),
  freshnessRules: new Map(),
  structure: { h1Count: 1, h2Count: 3, internalLinkCount: 2, faqCount: 3 },
  corpusPages: [],
  categoryFacts: new Set<string>(),
  pageFacts: new Set(["page_count:812"]),
  now: NOW,
  // These fixtures are one-sentence bodies, well under a real page's
  // length — lower the word-count floor so tests not specifically
  // about thin-content don't trip it incidentally. thinContent.test.ts
  // covers the production 150-word default directly.
  thinContentLimits: { templatedRatioMax: 0.7, minMetadataOnlyWordCount: 5, minInformationGain: 0.15 },
};

describe("runDeterministicChecks", () => {
  it("passes a clean page with no failures anywhere", () => {
    const page = goodPage();
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: page.blocks.map((b) => b.body).join(" "),
    });
    expect(result.passed).toBe(true);
    expect(result.allFailures).toEqual([]);
    expect(result.blocksToRegenerate.size).toBe(0);
    expect(result.hasPageLevelFailure).toBe(false);
  });

  it("routes a claim-level exact-match failure to block-level regeneration, not a whole-page failure", () => {
    const page = goodPage();
    page.claims[0]!.claimText = "The 2025 edition runs to 900 pages."; // wrong number
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: page.blocks.map((b) => b.body).join(" "),
    });
    expect(result.passed).toBe(false);
    expect(result.blocksToRegenerate).toEqual(new Set([1]));
    const exactMatchStage = result.stageResults.find((s) => s.stage === "exact_match");
    expect(exactMatchStage?.passed).toBe(false);
  });

  it("flags a page-level SEO structure failure separately from block-level failures", () => {
    const page = goodPage();
    page.metaTitle = "x".repeat(80); // over the 60-char limit
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: page.blocks.map((b) => b.body).join(" "),
    });
    expect(result.hasPageLevelFailure).toBe(true);
    expect(result.blocksToRegenerate.size).toBe(0); // no block-level failure here
    const seoStage = result.stageResults.find((s) => s.stage === "seo_structure");
    expect(seoStage?.passed).toBe(false);
  });

  it("flags banned phrases found in the rendered text", () => {
    const page = goodPage();
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: "In today's fast-paced world, this book delivers.",
    });
    const bannedStage = result.stageResults.find((s) => s.stage === "banned_phrase");
    expect(bannedStage?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("flags near-duplicate text against the corpus", () => {
    const page = goodPage();
    const text = page.blocks.map((b) => b.body).join(" ");
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: text,
      corpusPages: [{ pageId: 99, text, category: "ssc", facts: new Set() }], // identical text
    });
    const dupStage = result.stageResults.find((s) => s.stage === "duplicate");
    expect(dupStage?.passed).toBe(false);
    expect(result.seoAudit.duplicateAgainstPageId).toBe(99);
    expect(result.seoAudit.duplicateMaxSimilarity).toBe(1);
  });

  it("produces one stage result for every deterministic stage, always, even on a clean page", () => {
    const page = goodPage();
    const result = runDeterministicChecks({
      ...baseInput,
      page,
      renderedText: page.blocks.map((b) => b.body).join(" "),
    });
    const stages = result.stageResults.map((s) => s.stage).sort();
    expect(stages).toEqual(
      ["banned_phrase", "duplicate", "evidence_integrity", "exact_match", "seo_structure", "thin_content"].sort(),
    );
  });
});
