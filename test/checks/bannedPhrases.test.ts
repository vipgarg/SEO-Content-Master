import { describe, expect, it } from "vitest";
import { checkBannedPhrases, DEFAULT_BANNED_PHRASES } from "../../src/checks/bannedPhrases.js";

describe("checkBannedPhrases", () => {
  it("flags a banned phrase from the plan's own examples", () => {
    const failures = checkBannedPhrases("In today's fast-paced world, exam prep matters.");
    expect(failures.some((f) => f.message.includes("fast-paced world"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(checkBannedPhrases("DELVE INTO the syllabus.")).toHaveLength(1);
  });

  it("passes clean text", () => {
    expect(checkBannedPhrases("This edition covers the full SSC CGL syllabus with 812 pages of practice sets.")).toEqual(
      [],
    );
  });

  it("flags every distinct phrase present, not just the first", () => {
    const failures = checkBannedPhrases("Look no further — delve into this game-changer of a book.");
    expect(failures.length).toBeGreaterThanOrEqual(3);
  });

  it("respects a custom phrase list instead of the default", () => {
    expect(checkBannedPhrases("delve into this", ["custom phrase"])).toEqual([]);
    expect(checkBannedPhrases("custom phrase here", ["custom phrase"])).toHaveLength(1);
  });

  it("the default list is non-empty and every entry compiles as a regex", () => {
    expect(DEFAULT_BANNED_PHRASES.length).toBeGreaterThan(0);
    for (const phrase of DEFAULT_BANNED_PHRASES) {
      expect(() => new RegExp(phrase, "gi")).not.toThrow();
    }
  });
});
