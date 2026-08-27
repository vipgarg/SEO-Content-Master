// Corpus uniqueness / thinness gate — plan §4a (generation-plan-v3.1.md).
// Distinct from shingling.ts: that catches pages that are near-duplicate
// TEXT. This catches pages that are each textually unique but
// structurally/informationally interchangeable — the actual pattern
// Google's scaled-content-abuse policy targets. See docs/generation-plan-v3.1.md
// §2.2 for why this exists as a blocking check, not just the advisory
// rubric.
//
// Three independent sub-checks, matched to seo_audits' columns
// (schema-v4.1.sql): skeleton_similarity_max, metadata_only_word_count,
// information_gain_score. All thresholds here are the plan's own
// "starting points, not fixed law" — calibrate against the 200-page
// human review, same as the rubric.

import type { CheckFailure } from "./types.js";
import { sentenceSkeleton, splitSentences } from "./textExtraction.js";

export interface ThinContentLimits {
  /** Fail if more than this fraction of sentences match a skeleton already seen in the corpus. Plan §4a: "~70%". */
  templatedRatioMax: number;
  /** Fail if fewer than this many words remain after stripping evidence-restatement sentences. */
  minMetadataOnlyWordCount: number;
  /** Fail if fewer than this fraction of the page's facts are new to its category. Skipped (not failed) when the category has no prior facts recorded. */
  minInformationGain: number;
}

export const DEFAULT_THIN_CONTENT_LIMITS: ThinContentLimits = {
  templatedRatioMax: 0.7,
  minMetadataOnlyWordCount: 150,
  minInformationGain: 0.15,
};

// --- Sub-check 1: non-templated sentence ratio ---------------------

export function buildCorpusSkeletonSet(corpusTexts: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const text of corpusTexts) {
    for (const sentence of splitSentences(text)) {
      set.add(sentenceSkeleton(sentence));
    }
  }
  return set;
}

export interface TemplatedRatioResult {
  ratio: number;
  templatedCount: number;
  total: number;
}

export function templatedSentenceRatio(
  pageText: string,
  corpusSkeletons: ReadonlySet<string>,
): TemplatedRatioResult {
  const sentences = splitSentences(pageText);
  if (sentences.length === 0) return { ratio: 0, templatedCount: 0, total: 0 };
  let templatedCount = 0;
  for (const sentence of sentences) {
    if (corpusSkeletons.has(sentenceSkeleton(sentence))) templatedCount++;
  }
  return { ratio: templatedCount / sentences.length, templatedCount, total: sentences.length };
}

// --- Sub-check 2: metadata-only test --------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "of", "in", "on",
  "at", "to", "for", "and", "or", "with", "this", "that", "it", "its", "by",
  "from", "as", "has", "have", "had", "you", "your", "which", "who", "if",
]);

/**
 * A sentence counts as "metadata-only" if, after removing every
 * evidence-value token this page actually cites and any standalone
 * number, fewer than 5 non-stopword content words remain. Threshold is
 * deliberately small and simple — this is meant to catch "the book has
 * 812 pages and costs ₹499" (0-1 content words survive that strip), not
 * to be a real content-quality model.
 */
export function isMetadataOnlySentence(sentence: string, evidenceValues: readonly string[]): boolean {
  let stripped = sentence;
  for (const value of evidenceValues) {
    if (!value) continue;
    stripped = stripped.split(value).join(" ");
  }
  stripped = stripped.replace(/\d[\d,.]*/g, " ");
  const words = stripped
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const contentWords = words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return contentWords.length <= 4;
}

export function metadataOnlyWordCount(pageText: string, evidenceValues: readonly string[]): number {
  let total = 0;
  for (const sentence of splitSentences(pageText)) {
    if (!isMetadataOnlySentence(sentence, evidenceValues)) {
      total += sentence.split(/\s+/).filter(Boolean).length;
    }
  }
  return total;
}

// --- Sub-check 3: corpus-relative information gain -------------------

/**
 * Fraction of this page's facts not already stated identically
 * elsewhere in its category. `pageFacts`/`categoryFacts` are
 * "attribute:value" strings (see types.ts CorpusPage.facts). Returns
 * null (not measurable — never a failure) when the page asserts no
 * facts at all, or when the category has no prior published facts to
 * compare against (its first page necessarily "adds" everything).
 */
export function informationGain(
  pageFacts: ReadonlySet<string>,
  categoryFacts: ReadonlySet<string>,
): number | null {
  if (pageFacts.size === 0) return null;
  if (categoryFacts.size === 0) return null;
  let newCount = 0;
  for (const fact of pageFacts) {
    if (!categoryFacts.has(fact)) newCount++;
  }
  return newCount / pageFacts.size;
}

// --- Orchestration ----------------------------------------------------

export interface ThinContentInput {
  pageText: string;
  pageFacts: ReadonlySet<string>;
  corpusSkeletons: ReadonlySet<string>;
  categoryFacts: ReadonlySet<string>;
  evidenceValues: readonly string[];
}

export interface ThinContentResult {
  skeletonSimilarityRatio: number;
  metadataOnlyWordCount: number;
  informationGainScore: number | null;
  thinContentFlag: boolean;
  failures: CheckFailure[];
}

export function checkThinContent(
  input: ThinContentInput,
  limits: ThinContentLimits = DEFAULT_THIN_CONTENT_LIMITS,
): ThinContentResult {
  const failures: CheckFailure[] = [];

  const { ratio } = templatedSentenceRatio(input.pageText, input.corpusSkeletons);
  if (ratio > limits.templatedRatioMax) {
    failures.push({
      stage: "thin_content",
      code: "high_templated_ratio",
      message: `${Math.round(ratio * 100)}% of sentences match a skeleton already published, over the ${Math.round(limits.templatedRatioMax * 100)}% limit.`,
      severity: "page",
    });
  }

  const wordCount = metadataOnlyWordCount(input.pageText, input.evidenceValues);
  if (wordCount < limits.minMetadataOnlyWordCount) {
    failures.push({
      stage: "thin_content",
      code: "insufficient_non_metadata_content",
      message: `Only ${wordCount} words remain after stripping metadata-restatement sentences, under the ${limits.minMetadataOnlyWordCount}-word minimum.`,
      severity: "page",
    });
  }

  const gain = informationGain(input.pageFacts, input.categoryFacts);
  if (gain !== null && gain < limits.minInformationGain) {
    failures.push({
      stage: "thin_content",
      code: "low_information_gain",
      message: `Only ${Math.round(gain * 100)}% of this page's facts are new to its category, under the ${Math.round(limits.minInformationGain * 100)}% minimum.`,
      severity: "page",
    });
  }

  return {
    skeletonSimilarityRatio: ratio,
    metadataOnlyWordCount: wordCount,
    informationGainScore: gain,
    thinContentFlag: failures.length > 0,
    failures,
  };
}
