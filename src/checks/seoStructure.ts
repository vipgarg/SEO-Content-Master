// Structural SEO check (plan §5 Step 4): "Meta title ≤ 60 chars,
// description ≤ 155, exactly one H1, ≥3 H2s, ≥2 internal links, FAQ
// count within range."
//
// Operates on a RenderedStructure the caller computes — this repo
// doesn't have an Astro renderer yet, so heading/link/FAQ counts are
// supplied rather than parsed from markup here. Keeping the check pure
// and renderer-agnostic means it doesn't need to change when the
// renderer is built; only the caller wiring does.

import type { CheckFailure, RenderedStructure } from "./types.js";

export interface SeoStructureLimits {
  metaTitleMaxLen: number;
  metaDescriptionMaxLen: number;
  minH2: number;
  minInternalLinks: number;
  faqCountMin: number;
  faqCountMax: number;
}

export const DEFAULT_SEO_LIMITS: SeoStructureLimits = {
  metaTitleMaxLen: 60,
  metaDescriptionMaxLen: 155,
  minH2: 3,
  minInternalLinks: 2,
  faqCountMin: 2,
  faqCountMax: 8,
};

export function checkSeoStructure(
  metaTitle: string,
  metaDescription: string,
  structure: RenderedStructure,
  limits: SeoStructureLimits = DEFAULT_SEO_LIMITS,
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const fail = (code: string, message: string): void => {
    failures.push({ stage: "seo_structure", code, message, severity: "page" });
  };

  if (metaTitle.length > limits.metaTitleMaxLen) {
    fail("meta_title_too_long", `Meta title is ${metaTitle.length} chars, over the ${limits.metaTitleMaxLen}-char limit.`);
  }
  if (metaTitle.length === 0) {
    fail("meta_title_empty", "Meta title is empty.");
  }
  if (metaDescription.length > limits.metaDescriptionMaxLen) {
    fail(
      "meta_description_too_long",
      `Meta description is ${metaDescription.length} chars, over the ${limits.metaDescriptionMaxLen}-char limit.`,
    );
  }
  if (metaDescription.length === 0) {
    fail("meta_description_empty", "Meta description is empty.");
  }
  if (structure.h1Count !== 1) {
    fail("h1_count_wrong", `Page has ${structure.h1Count} H1s, expected exactly 1.`);
  }
  if (structure.h2Count < limits.minH2) {
    fail("h2_count_too_low", `Page has ${structure.h2Count} H2s, minimum is ${limits.minH2}.`);
  }
  if (structure.internalLinkCount < limits.minInternalLinks) {
    fail(
      "internal_links_too_few",
      `Page has ${structure.internalLinkCount} internal links, minimum is ${limits.minInternalLinks}.`,
    );
  }
  if (structure.faqCount < limits.faqCountMin || structure.faqCount > limits.faqCountMax) {
    fail(
      "faq_count_out_of_range",
      `Page has ${structure.faqCount} FAQs, expected between ${limits.faqCountMin} and ${limits.faqCountMax}.`,
    );
  }

  return failures;
}
