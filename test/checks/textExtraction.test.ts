import { describe, expect, it } from "vitest";
import {
  extractDates,
  extractIsbns,
  extractNumbers,
  normalizeEntityText,
  sentenceSkeleton,
  splitSentences,
} from "../../src/checks/textExtraction.js";

describe("extractNumbers", () => {
  it("extracts plain and comma-separated numbers", () => {
    expect(extractNumbers("the 2025 edition runs to 812 pages")).toEqual([2025, 812]);
    expect(extractNumbers("priced at 1,299 rupees")).toEqual([1299]);
    expect(extractNumbers("a score of 4.5 out of 5")).toEqual([4.5, 5]);
  });

  it("returns an empty array when there are no numbers", () => {
    expect(extractNumbers("no numbers here")).toEqual([]);
  });
});

describe("extractDates", () => {
  it("extracts ISO dates", () => {
    expect(extractDates("published on 2025-06-01")).toEqual(["2025-06-01"]);
  });

  it("extracts 'DD Month YYYY' dates", () => {
    expect(extractDates("released 1 June 2025")).toEqual(["2025-06-01"]);
    expect(extractDates("released 1st June 2025")).toEqual(["2025-06-01"]);
  });

  it("extracts 'Month DD, YYYY' dates", () => {
    expect(extractDates("released June 1, 2025")).toEqual(["2025-06-01"]);
  });

  it("returns an empty array for text with no date", () => {
    expect(extractDates("this book has 812 pages")).toEqual([]);
  });
});

describe("extractIsbns", () => {
  it("extracts and normalizes a hyphenated ISBN-13", () => {
    expect(extractIsbns("ISBN 978-93-5476-123-4 is the edition")).toEqual(["9789354761234"]);
  });

  it("extracts a bare 13-digit ISBN", () => {
    expect(extractIsbns("9789354761234")).toEqual(["9789354761234"]);
  });

  it("finds nothing in text with no ISBN-shaped string", () => {
    expect(extractIsbns("this book has 812 pages")).toEqual([]);
  });
});

describe("normalizeEntityText", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeEntityText("  Arihant   Publications, Pvt. Ltd.  ")).toBe("arihant publications pvt ltd");
  });

  it("strips diacritics", () => {
    expect(normalizeEntityText("Café Münster")).toBe("cafe munster");
  });
});

describe("splitSentences", () => {
  it("splits on sentence boundaries followed by a capital or digit", () => {
    expect(splitSentences("This is one. This is two! Is this three? Yes.")).toEqual([
      "This is one.",
      "This is two!",
      "Is this three?",
      "Yes.",
    ]);
  });

  it("does not split on a mid-sentence abbreviation period followed by lowercase", () => {
    expect(splitSentences("Published by Arihant Pub. in 2025.")).toEqual(["Published by Arihant Pub. in 2025."]);
  });
});

describe("sentenceSkeleton", () => {
  it("collapses numbers and proper-noun runs so structurally-identical sentences match", () => {
    const a = sentenceSkeleton("The 2025 edition of Lucent GK runs to 812 pages.");
    const b = sentenceSkeleton("The 2024 edition of Arihant SSC runs to 640 pages.");
    expect(a).toBe(b);
  });

  it("does not collapse sentences with a genuinely different structure", () => {
    const a = sentenceSkeleton("The 2025 edition runs to 812 pages.");
    const b = sentenceSkeleton("Students preparing for SSC CGL often ask about negative marking.");
    expect(a).not.toBe(b);
  });
});
