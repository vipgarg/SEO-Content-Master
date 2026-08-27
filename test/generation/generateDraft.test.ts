import { describe, expect, it, vi } from "vitest";
import type { ClaudeCallOptions, ClaudeCallResult } from "../../src/generation/claudeClient.js";
import { generateDraft, GenerationError } from "../../src/generation/generateDraft.js";
import { DRAFT_TOOL_NAME } from "../../src/generation/prompts.js";
import type { DraftPage, GenerationInput } from "../../src/generation/types.js";

function input(): GenerationInput {
  return {
    pageId: 1,
    brief: {
      pageType: "book",
      outline: {},
      wordBudgetMin: 100,
      wordBudgetMax: 500,
      minEvidence: 1,
      descriptiveRatioMax: 0.4,
      faqCountMin: 2,
      faqCountMax: 8,
    },
    evidencePack: [{ id: 1, attribute: "page_count", valueText: null, valueNum: 812, valueDate: null, sourceType: "publisher" }],
    styleGuide: "Plain prose.",
    bannedPhrases: [],
  };
}

function validDraft(): DraftPage {
  return {
    meta_title: "Title",
    meta_description: "Description.",
    unsupported_flags: [],
    blocks: [
      {
        block_key: "b1",
        block_type: "paragraph",
        section: null,
        heading: null,
        body: "812 pages.",
        is_required: true,
        claims: [{ claim_key: "c1", claim_text: "812 pages", claim_type: "numeric", evidence_ids: [1] }],
      },
    ],
  };
}

describe("generateDraft", () => {
  it("calls Claude exactly twice — draft, then self-critique — in that order", async () => {
    const calls: ClaudeCallOptions[] = [];
    const claudeCall = vi.fn(async (opts: ClaudeCallOptions): Promise<ClaudeCallResult<unknown>> => {
      calls.push(opts);
      return { data: validDraft(), inputTokens: 100, outputTokens: 50 };
    });

    await generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never });

    expect(claudeCall).toHaveBeenCalledTimes(2);
    expect(calls[0]?.toolName).toBe(DRAFT_TOOL_NAME);
    expect(calls[1]?.toolName).toBe(DRAFT_TOOL_NAME);
    // The second call's user message is the self-critique prompt, which
    // embeds the first call's output — proves it's a chain, not two
    // independent calls with the same input.
    expect(calls[1]?.userMessage).toContain("review");
    // Not a JSON.stringify(validDraft()) substring match — the object
    // passed to the second call is initialDraft, which is
    // parseDraftPage's *reconstruction* of the model's output (fixed
    // key order: meta_title, meta_description, blocks,
    // unsupported_flags), not the raw literal, so key order can differ
    // from how the test constructs its own fixture.
    expect(calls[1]?.userMessage).toContain('"meta_title":"Title"');
    expect(calls[1]?.userMessage).toContain('"body":"812 pages."');
  });

  it("sums token usage across both calls", async () => {
    const claudeCall = vi.fn(async (): Promise<ClaudeCallResult<unknown>> => ({
      data: validDraft(),
      inputTokens: 100,
      outputTokens: 50,
    }));
    const result = await generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never });
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);
  });

  it("returns both the self-critiqued draft and the pre-critique initial draft", async () => {
    const initial = validDraft();
    const critiqued: DraftPage = { ...initial, meta_title: "Revised Title" };
    let callCount = 0;
    const claudeCall = vi.fn(async (): Promise<ClaudeCallResult<unknown>> => {
      callCount++;
      return { data: callCount === 1 ? initial : critiqued };
    });
    const result = await generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never });
    expect(result.initialDraft.meta_title).toBe("Title");
    expect(result.draft.meta_title).toBe("Revised Title");
  });

  it("throws GenerationError, without a second call, when the initial draft cites an unknown evidence id", async () => {
    const badDraft = validDraft();
    badDraft.blocks[0]!.claims[0]!.evidence_ids = [999]; // not in the pack (pack only has id 1)
    const claudeCall = vi.fn(async (): Promise<ClaudeCallResult<unknown>> => ({ data: badDraft }));

    await expect(generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never })).rejects.toThrow(
      GenerationError,
    );
    expect(claudeCall).toHaveBeenCalledTimes(1); // never reached self-critique
  });

  it("throws GenerationError when the self-critiqued draft (re-)introduces an unknown evidence id", async () => {
    let callCount = 0;
    const claudeCall = vi.fn(async (): Promise<ClaudeCallResult<unknown>> => {
      callCount++;
      if (callCount === 1) return { data: validDraft() };
      const bad = validDraft();
      bad.blocks[0]!.claims[0]!.evidence_ids = [999];
      return { data: bad };
    });
    await expect(generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never })).rejects.toThrow(
      GenerationError,
    );
    expect(claudeCall).toHaveBeenCalledTimes(2); // this time it got past the first check
  });

  it("propagates a schema-validation failure as DraftValidationError-wrapped rejection", async () => {
    const claudeCall = vi.fn(async (): Promise<ClaudeCallResult<unknown>> => ({ data: { not: "a valid draft" } }));
    await expect(generateDraft(input(), { apiKey: "k", model: "claude-x", claudeCall: claudeCall as never })).rejects.toThrow();
  });
});
