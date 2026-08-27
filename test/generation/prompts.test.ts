import { describe, expect, it } from "vitest";
import {
  buildDraftSystemPrompt,
  buildDraftUserMessage,
  buildSelfCritiqueUserMessage,
  DRAFT_TOOL_NAME,
  DRAFT_TOOL_SCHEMA,
} from "../../src/generation/prompts.js";
import type { DraftPage, GenerationInput } from "../../src/generation/types.js";

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    pageId: 1,
    brief: {
      pageType: "book",
      outline: { sections: ["intro", "specs", "faq"] },
      wordBudgetMin: 400,
      wordBudgetMax: 800,
      minEvidence: 6,
      descriptiveRatioMax: 0.4,
      faqCountMin: 2,
      faqCountMax: 8,
    },
    evidencePack: [
      { id: 1, attribute: "page_count", valueText: null, valueNum: 812, valueDate: null, sourceType: "publisher" },
      { id: 2, attribute: "isbn13", valueText: "9789354761234", valueNum: null, valueDate: null, sourceType: "publisher" },
    ],
    styleGuide: "Write in plain, confident prose.",
    bannedPhrases: ["delve into", "look no further"],
    ...overrides,
  };
}

describe("buildDraftSystemPrompt", () => {
  it("includes the hard evidence requirement and the word budget", () => {
    const prompt = buildDraftSystemPrompt(input());
    expect(prompt).toContain("must carry a claim object");
    expect(prompt).toContain("unsupported_flags");
    expect(prompt).toContain("400–800 words");
  });

  it("includes every banned phrase", () => {
    const prompt = buildDraftSystemPrompt(input());
    expect(prompt).toContain("delve into");
    expect(prompt).toContain("look no further");
  });

  it("includes the FAQ count range and descriptive ratio limit", () => {
    const prompt = buildDraftSystemPrompt(input());
    expect(prompt).toContain("2–8 FAQ");
    expect(prompt).toContain("40%");
  });
});

describe("buildDraftUserMessage", () => {
  it("includes every evidence pack item's id, attribute, and value", () => {
    const msg = buildDraftUserMessage(input());
    expect(msg).toContain("[id=1] page_count = 812");
    expect(msg).toContain("[id=2] isbn13 = 9789354761234");
  });

  it("references the tool name so the model knows what to call", () => {
    expect(buildDraftUserMessage(input())).toContain(DRAFT_TOOL_NAME);
  });
});

describe("buildSelfCritiqueUserMessage", () => {
  const draft: DraftPage = {
    meta_title: "Title",
    meta_description: "Description.",
    blocks: [
      {
        block_key: "b1",
        block_type: "paragraph",
        section: null,
        heading: null,
        body: "The book has 812 pages.",
        is_required: true,
        claims: [{ claim_key: "c1", claim_text: "812 pages", claim_type: "numeric", evidence_ids: [1] }],
      },
    ],
    unsupported_flags: [],
  };

  it("includes the prior draft's content so the model can review it", () => {
    const msg = buildSelfCritiqueUserMessage(input(), draft);
    expect(msg).toContain("The book has 812 pages.");
  });

  it("asks for a full corrected draft, not a diff", () => {
    const msg = buildSelfCritiqueUserMessage(input(), draft);
    expect(msg.toLowerCase()).toContain("full page");
  });
});

describe("DRAFT_TOOL_SCHEMA", () => {
  it("requires the top-level fields the parser expects", () => {
    expect(DRAFT_TOOL_SCHEMA.required).toEqual(["meta_title", "meta_description", "blocks"]);
  });

  it("enumerates every claim type and block type this codebase's DB enum supports", () => {
    const claimTypeEnum = DRAFT_TOOL_SCHEMA.properties.blocks.items.properties.claims.items.properties.claim_type.enum;
    expect(claimTypeEnum).toEqual(["numeric", "date", "identifier", "entity", "categorical", "descriptive"]);
    const blockTypeEnum = DRAFT_TOOL_SCHEMA.properties.blocks.items.properties.block_type.enum;
    expect(blockTypeEnum).toEqual(["heading", "paragraph", "list", "table", "faq", "cta", "pros_cons"]);
  });
});
