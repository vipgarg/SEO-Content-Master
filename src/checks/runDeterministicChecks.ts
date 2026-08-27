// Orchestrates plan §5 Step 4 (+ §4a): runs every deterministic check
// on a page draft and produces the routing decision. Pure — takes
// already-loaded data, returns a result; src/checks/db.ts is the only
// place that touches Postgres. Same split as the gemini worker.
//
// Order matches the plan's "free checks first" principle and the
// dependency between stages: evidence integrity has to be known before
// exact-match can trust it, everything else is independent and always
// runs (so a page gets one full report, not a report that stops at the
// first thing wrong with it — plan §5 Step 4 routes "regenerate the
// offending block only, never the whole page", which needs to know
// about every offending block in one pass, not just the first).

import { checkBannedPhrases, DEFAULT_BANNED_PHRASES } from "./bannedPhrases.js";
import { checkEvidenceIntegrity } from "./evidenceIntegrity.js";
import { checkClaimExactMatch } from "./exactMatch.js";
import { DEFAULT_SEO_LIMITS, checkSeoStructure, type SeoStructureLimits } from "./seoStructure.js";
import { maxSimilarityAgainstCorpus } from "./shingling.js";
import {
  DEFAULT_THIN_CONTENT_LIMITS,
  buildCorpusSkeletonSet,
  checkThinContent,
  type ThinContentLimits,
} from "./thinContent.js";
import type {
  CheckFailure,
  CorpusPage,
  DeterministicStage,
  EvidenceRow,
  FreshnessRule,
  PageDraft,
  RenderedStructure,
  StageResult,
} from "./types.js";

export interface DeterministicChecksInput {
  page: PageDraft;
  evidenceById: ReadonlyMap<number, EvidenceRow>;
  freshnessRules: ReadonlyMap<string, FreshnessRule>;
  structure: RenderedStructure;
  renderedText: string;
  /** Every currently-published page, for duplicate + thin-content comparison. */
  corpusPages: readonly CorpusPage[];
  /** Facts already published elsewhere in this page's category (§4a information gain). */
  categoryFacts: ReadonlySet<string>;
  /** This page's own asserted facts, as "attribute:value" strings — same shape as CorpusPage.facts. */
  pageFacts: ReadonlySet<string>;
  seoLimits?: SeoStructureLimits;
  bannedPhrases?: readonly string[];
  thinContentLimits?: ThinContentLimits;
  duplicateShingleSize?: number;
  now?: Date;
}

export interface SeoAuditFields {
  h1Count: number;
  h2Count: number;
  metaTitleLen: number;
  metaDescLen: number;
  internalLinks: number;
  faqCount: number;
  duplicateMaxSimilarity: number;
  duplicateAgainstPageId: number | null;
  templatedSentenceRatio: number;
  metadataOnlyWordCount: number;
  informationGainScore: number | null;
  thinContentFlag: boolean;
}

export interface DeterministicChecksResult {
  stageResults: StageResult[];
  allFailures: CheckFailure[];
  /** True only if nothing failed anywhere — no block-level or page-level failures. */
  passed: boolean;
  /** Block ids that need regeneration (block-severity failures only — plan: "regenerate the offending block only"). */
  blocksToRegenerate: ReadonlySet<number>;
  /** True if any page-severity failure occurred — these can't be fixed by regenerating one block. */
  hasPageLevelFailure: boolean;
  seoAudit: SeoAuditFields;
}

function groupByStage(failures: CheckFailure[]): StageResult[] {
  const stages: DeterministicStage[] = [
    "evidence_integrity",
    "exact_match",
    "seo_structure",
    "banned_phrase",
    "duplicate",
    "thin_content",
  ];
  return stages.map((stage) => {
    const stageFailures = failures.filter((f) => f.stage === stage);
    return { stage, passed: stageFailures.length === 0, failures: stageFailures };
  });
}

export function runDeterministicChecks(input: DeterministicChecksInput): DeterministicChecksResult {
  const now = input.now ?? new Date();
  const allFailures: CheckFailure[] = [];

  // Evidence integrity + exact-match, per claim.
  for (const claim of input.page.claims) {
    const integrityFailures = checkEvidenceIntegrity(claim, input.evidenceById, input.freshnessRules, now);
    allFailures.push(...integrityFailures);
    // Exact-match still runs even if integrity failed for *some* of the
    // claim's evidence ids — it silently skips comparisons against
    // whichever ids are missing/broken (checkClaimExactMatch's own
    // contract) and still checks any that resolved fine.
    allFailures.push(...checkClaimExactMatch(claim, input.evidenceById));
  }

  // SEO structure.
  allFailures.push(
    ...checkSeoStructure(input.page.metaTitle, input.page.metaDescription, input.structure, input.seoLimits ?? DEFAULT_SEO_LIMITS),
  );

  // Banned phrases.
  allFailures.push(...checkBannedPhrases(input.renderedText, input.bannedPhrases ?? DEFAULT_BANNED_PHRASES));

  // Duplicate shingling.
  const duplicate = maxSimilarityAgainstCorpus(
    input.renderedText,
    input.corpusPages.map((p) => ({ pageId: p.pageId, text: p.text })),
    input.duplicateShingleSize ?? 5,
  );
  const DUPLICATE_SIMILARITY_THRESHOLD = 0.5;
  if (duplicate.maxSimilarity > DUPLICATE_SIMILARITY_THRESHOLD) {
    allFailures.push({
      stage: "duplicate",
      code: "near_duplicate",
      message: `Page is ${Math.round(duplicate.maxSimilarity * 100)}% shingle-similar to published page ${duplicate.matchedPageId}, over the ${Math.round(DUPLICATE_SIMILARITY_THRESHOLD * 100)}% limit.`,
      severity: "page",
    });
  }

  // Thin content (§4a).
  const corpusSkeletons = buildCorpusSkeletonSet(input.corpusPages.map((p) => p.text));
  const evidenceValues = [...input.evidenceById.values()]
    .map((e) => e.valueText ?? (e.valueNum !== null ? String(e.valueNum) : null))
    .filter((v): v is string => v !== null);
  const thinContent = checkThinContent(
    {
      pageText: input.renderedText,
      pageFacts: input.pageFacts,
      corpusSkeletons,
      categoryFacts: input.categoryFacts,
      evidenceValues,
    },
    input.thinContentLimits ?? DEFAULT_THIN_CONTENT_LIMITS,
  );
  allFailures.push(...thinContent.failures);

  const blocksToRegenerate = new Set(
    allFailures.filter((f): f is CheckFailure & { blockId: number } => f.severity === "block" && f.blockId !== undefined).map((f) => f.blockId),
  );
  const hasPageLevelFailure = allFailures.some((f) => f.severity === "page");

  return {
    stageResults: groupByStage(allFailures),
    allFailures,
    passed: allFailures.length === 0,
    blocksToRegenerate,
    hasPageLevelFailure,
    seoAudit: {
      h1Count: input.structure.h1Count,
      h2Count: input.structure.h2Count,
      metaTitleLen: input.page.metaTitle.length,
      metaDescLen: input.page.metaDescription.length,
      internalLinks: input.structure.internalLinkCount,
      faqCount: input.structure.faqCount,
      duplicateMaxSimilarity: duplicate.maxSimilarity,
      duplicateAgainstPageId: duplicate.matchedPageId,
      templatedSentenceRatio: thinContent.skeletonSimilarityRatio,
      metadataOnlyWordCount: thinContent.metadataOnlyWordCount,
      informationGainScore: thinContent.informationGainScore,
      thinContentFlag: thinContent.thinContentFlag,
    },
  };
}
