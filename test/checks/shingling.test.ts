import { describe, expect, it } from "vitest";
import { jaccardSimilarity, maxSimilarityAgainstCorpus, wordShingles } from "../../src/checks/shingling.js";

describe("wordShingles", () => {
  it("produces overlapping k-word windows", () => {
    const shingles = wordShingles("the quick brown fox jumps", 3);
    expect(shingles).toEqual(new Set(["the quick brown", "quick brown fox", "brown fox jumps"]));
  });

  it("returns an empty set when text is shorter than k words", () => {
    expect(wordShingles("too short", 5).size).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical shingle sets", () => {
    const a = wordShingles("the quick brown fox jumps over", 3);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    const a = wordShingles("the quick brown fox jumps", 3);
    const b = wordShingles("totally unrelated content about exams", 3);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("is between 0 and 1 for partial overlap", () => {
    const a = wordShingles("this book covers the full syllabus for SSC CGL exam preparation", 3);
    const b = wordShingles("this book covers the full syllabus for UPSC exam preparation", 3);
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("is 0, not NaN, for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe("maxSimilarityAgainstCorpus", () => {
  it("finds the most similar page and reports its id", () => {
    const text = "this book covers the full syllabus for SSC CGL exam preparation with 812 pages";
    const corpus = [
      { pageId: 1, text: "a completely different book about cooking recipes and techniques" },
      { pageId: 2, text: "this book covers the full syllabus for SSC CGL exam preparation with 900 pages" },
    ];
    const result = maxSimilarityAgainstCorpus(text, corpus);
    expect(result.matchedPageId).toBe(2);
    expect(result.maxSimilarity).toBeGreaterThan(0.5);
  });

  it("returns similarity 0 and no match against an empty corpus", () => {
    const result = maxSimilarityAgainstCorpus("some text here", []);
    expect(result).toEqual({ maxSimilarity: 0, matchedPageId: null });
  });
});
