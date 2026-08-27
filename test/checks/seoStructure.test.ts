import { describe, expect, it } from "vitest";
import { checkSeoStructure, DEFAULT_SEO_LIMITS } from "../../src/checks/seoStructure.js";
import type { RenderedStructure } from "../../src/checks/types.js";

function structure(overrides: Partial<RenderedStructure> = {}): RenderedStructure {
  return { h1Count: 1, h2Count: 3, internalLinkCount: 2, faqCount: 3, ...overrides };
}

describe("checkSeoStructure", () => {
  it("passes a page that meets every limit exactly at the boundary", () => {
    const failures = checkSeoStructure("a".repeat(60), "b".repeat(155), structure(), DEFAULT_SEO_LIMITS);
    expect(failures).toEqual([]);
  });

  it("fails a meta title one char over the limit", () => {
    const failures = checkSeoStructure("a".repeat(61), "desc", structure(), DEFAULT_SEO_LIMITS);
    expect(failures.map((f) => f.code)).toContain("meta_title_too_long");
  });

  it("fails an empty meta title", () => {
    const failures = checkSeoStructure("", "desc", structure(), DEFAULT_SEO_LIMITS);
    expect(failures.map((f) => f.code)).toContain("meta_title_empty");
  });

  it("fails a meta description over the limit", () => {
    const failures = checkSeoStructure("title", "d".repeat(156), structure(), DEFAULT_SEO_LIMITS);
    expect(failures.map((f) => f.code)).toContain("meta_description_too_long");
  });

  it("fails when H1 count is not exactly 1", () => {
    expect(checkSeoStructure("t", "d", structure({ h1Count: 0 })).map((f) => f.code)).toContain("h1_count_wrong");
    expect(checkSeoStructure("t", "d", structure({ h1Count: 2 })).map((f) => f.code)).toContain("h1_count_wrong");
  });

  it("fails when H2 count is below the minimum", () => {
    const failures = checkSeoStructure("t", "d", structure({ h2Count: 2 }), DEFAULT_SEO_LIMITS);
    expect(failures.map((f) => f.code)).toContain("h2_count_too_low");
  });

  it("fails when internal links are below the minimum", () => {
    const failures = checkSeoStructure("t", "d", structure({ internalLinkCount: 1 }), DEFAULT_SEO_LIMITS);
    expect(failures.map((f) => f.code)).toContain("internal_links_too_few");
  });

  it("fails when FAQ count is outside the configured range on either side", () => {
    expect(checkSeoStructure("t", "d", structure({ faqCount: 1 }), DEFAULT_SEO_LIMITS).map((f) => f.code)).toContain(
      "faq_count_out_of_range",
    );
    expect(checkSeoStructure("t", "d", structure({ faqCount: 9 }), DEFAULT_SEO_LIMITS).map((f) => f.code)).toContain(
      "faq_count_out_of_range",
    );
  });

  it("reports every violation in one pass, not just the first", () => {
    const failures = checkSeoStructure("", "d".repeat(200), structure({ h1Count: 0, h2Count: 0 }), DEFAULT_SEO_LIMITS);
    const codes = failures.map((f) => f.code);
    expect(codes).toContain("meta_title_empty");
    expect(codes).toContain("meta_description_too_long");
    expect(codes).toContain("h1_count_wrong");
    expect(codes).toContain("h2_count_too_low");
  });
});
