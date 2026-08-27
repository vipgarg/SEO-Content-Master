import { describe, expect, it } from "vitest";
import {
  buildCorpusSkeletonSet,
  checkThinContent,
  informationGain,
  isMetadataOnlySentence,
  metadataOnlyWordCount,
  templatedSentenceRatio,
} from "../../src/checks/thinContent.js";

describe("templatedSentenceRatio", () => {
  it("is 0 against an empty corpus", () => {
    expect(templatedSentenceRatio("Some page text here.", new Set()).ratio).toBe(0);
  });

  it("is 1 when every sentence's skeleton already exists in the corpus", () => {
    const corpus = buildCorpusSkeletonSet([
      "The 2024 edition of Arihant SSC runs to 640 pages. It costs 499 rupees.",
    ]);
    const { ratio } = templatedSentenceRatio(
      "The 2025 edition of Lucent GK runs to 812 pages. It costs 399 rupees.",
      corpus,
    );
    expect(ratio).toBe(1);
  });

  it("is 0 when no sentence matches a prior skeleton", () => {
    const corpus = buildCorpusSkeletonSet(["The 2024 edition of Arihant SSC runs to 640 pages."]);
    const { ratio } = templatedSentenceRatio(
      "Students often struggle with time management in the quantitative section.",
      corpus,
    );
    expect(ratio).toBe(0);
  });

  it("reports a partial ratio when some sentences are templated and some aren't", () => {
    const corpus = buildCorpusSkeletonSet(["The 2024 edition of Arihant SSC runs to 640 pages."]);
    const { ratio, templatedCount, total } = templatedSentenceRatio(
      "The 2025 edition of Lucent GK runs to 812 pages. Its practice sets emphasize speed over rote memorization.",
      corpus,
    );
    expect(total).toBe(2);
    expect(templatedCount).toBe(1);
    expect(ratio).toBe(0.5);
  });
});

describe("isMetadataOnlySentence / metadataOnlyWordCount", () => {
  it("treats a pure evidence-value restatement as metadata-only", () => {
    expect(isMetadataOnlySentence("The book has 812 pages and costs 499 rupees.", ["812", "499"])).toBe(true);
  });

  it("does not treat a sentence with real added content as metadata-only", () => {
    expect(
      isMetadataOnlySentence(
        "The 812-page volume emphasizes speed-based problem solving over rote formula memorization.",
        ["812"],
      ),
    ).toBe(false);
  });

  it("metadataOnlyWordCount excludes metadata-only sentences from the total", () => {
    const text =
      "The book has 812 pages and costs 499 rupees. " +
      "Its practice sets emphasize speed over rote memorization for time-pressured exam takers.";
    const count = metadataOnlyWordCount(text, ["812", "499"]);
    // Only the second sentence's words should count.
    const secondSentenceWordCount = "Its practice sets emphasize speed over rote memorization for time-pressured exam takers."
      .split(/\s+/).length;
    expect(count).toBe(secondSentenceWordCount);
  });

  it("is 0 for a page that is entirely metadata restatement", () => {
    expect(metadataOnlyWordCount("The book has 812 pages. It costs 499 rupees.", ["812", "499"])).toBe(0);
  });
});

describe("informationGain", () => {
  it("returns null when the page asserts no facts", () => {
    expect(informationGain(new Set(), new Set(["a:1"]))).toBeNull();
  });

  it("returns null (not a failure) when the category has no prior facts", () => {
    expect(informationGain(new Set(["a:1"]), new Set())).toBeNull();
  });

  it("computes the fraction of genuinely new facts", () => {
    const page = new Set(["page_count:812", "edition_year:2025", "publisher:Lucent"]);
    const category = new Set(["page_count:640", "edition_year:2025"]); // edition_year already seen, publisher/page_count new-ish
    // page_count:812 is new (different value), edition_year:2025 is a repeat, publisher:Lucent is new
    expect(informationGain(page, category)).toBeCloseTo(2 / 3);
  });

  it("is 1 when every fact is new", () => {
    const page = new Set(["a:1", "b:2"]);
    const category = new Set(["c:3"]);
    expect(informationGain(page, category)).toBe(1);
  });
});

describe("checkThinContent — orchestration", () => {
  it("passes a page with unique sentences, real content, and novel facts", () => {
    const result = checkThinContent(
      {
        pageText:
          "This edition restructures the quantitative aptitude section around speed drills rather than formula lists. " +
          "Reviewers highlight the worked-solution format as unusually detailed for a book at this price point.",
        pageFacts: new Set(["page_count:812", "edition_year:2025"]),
        corpusSkeletons: new Set(),
        categoryFacts: new Set(["page_count:640"]),
        evidenceValues: ["812", "2025"],
      },
      // Lower word-count floor than the 150-word production default —
      // this test is about the pass/fail *composition* across the
      // three sub-checks, not about re-proving the default threshold
      // (metadataOnlyWordCount's own tests cover that), and a synthetic
      // two-sentence fixture is deliberately shorter than a real page.
      { templatedRatioMax: 0.7, minMetadataOnlyWordCount: 20, minInformationGain: 0.15 },
    );
    expect(result.thinContentFlag).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("flags a page that is entirely templated restatement of metadata", () => {
    // Built from real prior text through the same buildCorpusSkeletonSet
    // path production code uses, rather than hand-typed skeleton
    // strings — those would have to exactly match sentenceSkeleton's
    // internal placeholder format to mean anything.
    const corpus = buildCorpusSkeletonSet([
      "The 2024 edition of Arihant SSC runs to 640 pages. It costs 349 rupees.",
    ]);
    const result = checkThinContent({
      pageText: "The 2025 edition of Lucent GK runs to 812 pages. It costs 399 rupees.",
      pageFacts: new Set(["page_count:812"]),
      corpusSkeletons: corpus,
      categoryFacts: new Set(["page_count:812"]), // fact already seen elsewhere too
      evidenceValues: ["812", "399", "2025"],
    });
    expect(result.thinContentFlag).toBe(true);
    const codes = result.failures.map((f) => f.code);
    expect(codes).toContain("high_templated_ratio");
    expect(codes).toContain("insufficient_non_metadata_content");
    expect(codes).toContain("low_information_gain");
  });
});
