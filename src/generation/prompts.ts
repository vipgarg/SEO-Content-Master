// Prompt construction for plan §5 Steps 2–3 (draft + self-critique).
// Kept plain, like the Gemini prompts — this is the contract with
// Claude, not a place for cleverness.

import type { EvidencePackItem, GenerationInput, DraftPage } from "./types.js";

export const DRAFT_TOOL_NAME = "emit_page_draft";

const CLAIM_TYPE_ENUM = ["numeric", "date", "identifier", "entity", "categorical", "descriptive"];
const BLOCK_TYPE_ENUM = ["heading", "paragraph", "list", "table", "faq", "cta", "pros_cons"];

/** JSON Schema for the forced tool call — see types.ts for the corresponding TS shape and the note on v2 §7. */
export const DRAFT_TOOL_SCHEMA = {
  type: "object",
  required: ["meta_title", "meta_description", "blocks"],
  properties: {
    meta_title: { type: "string", description: "≤60 characters" },
    meta_description: { type: "string", description: "≤155 characters" },
    unsupported_flags: {
      type: "array",
      items: { type: "string" },
      description: "Facts you could not source from the evidence pack — note them here, never state them in prose.",
    },
    blocks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["block_key", "block_type", "body", "is_required", "claims"],
        properties: {
          block_key: { type: "string" },
          block_type: { type: "string", enum: BLOCK_TYPE_ENUM },
          section: { type: ["string", "null"] },
          heading: { type: ["string", "null"] },
          body: { type: "string" },
          is_required: { type: "boolean", description: "false ⇒ this block may be stripped instead of regenerated if it fails a check" },
          claims: {
            type: "array",
            items: {
              type: "object",
              required: ["claim_key", "claim_text", "claim_type", "evidence_ids"],
              properties: {
                claim_key: { type: "string" },
                claim_text: { type: "string" },
                claim_type: { type: "string", enum: CLAIM_TYPE_ENUM },
                evidence_ids: {
                  type: "array",
                  items: { type: "number" },
                  description: "Evidence pack ids this claim is grounded in. Required (non-empty) for every type except descriptive.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

function formatEvidencePack(pack: readonly EvidencePackItem[]): string {
  return pack
    .map((e) => {
      const value = e.valueText ?? e.valueNum ?? e.valueDate ?? "";
      return `[id=${e.id}] ${e.attribute} = ${value} (source: ${e.sourceType})`;
    })
    .join("\n");
}

export function buildDraftSystemPrompt(input: GenerationInput): string {
  return [
    "You write evidence-grounded book pages for an SEO content system. You never invent facts.",
    "",
    "Hard requirement: any sentence containing a number, date, edition, exam name, or superlative",
    "must carry a claim object citing the evidence id(s) it's grounded in. Anything you cannot",
    "source from the evidence pack below goes in unsupported_flags — never into the prose.",
    "",
    `Word budget: ${input.brief.wordBudgetMin}–${input.brief.wordBudgetMax} words.`,
    `Minimum ${input.brief.minEvidence} evidence rows must be reflected somewhere in the page.`,
    `Descriptive (unsourced) prose must stay under ${Math.round(input.brief.descriptiveRatioMax * 100)}% of total content.`,
    `Include ${input.brief.faqCountMin}–${input.brief.faqCountMax} FAQ entries as separate blocks.`,
    "",
    "Never use any of these phrases or their close paraphrases:",
    input.bannedPhrases.map((p) => `- ${p}`).join("\n"),
    "",
    "Style guide:",
    input.styleGuide,
  ].join("\n");
}

export function buildDraftUserMessage(input: GenerationInput): string {
  return [
    `Page type: ${input.brief.pageType}`,
    `Outline: ${JSON.stringify(input.brief.outline)}`,
    "",
    "Evidence pack (only cite these ids — anything else is a fabricated claim):",
    formatEvidencePack(input.evidencePack),
    "",
    `Call ${DRAFT_TOOL_NAME} with the complete page draft.`,
  ].join("\n");
}

export function buildSelfCritiqueUserMessage(input: GenerationInput, draft: DraftPage): string {
  return [
    "Here is a draft you just wrote, and the evidence pack it must be grounded in.",
    "List every sentence not fully supported by its cited evidence, then produce a corrected draft:",
    "rewrite or remove anything unsupported, move anything unsourceable to unsupported_flags,",
    "and keep everything else unchanged.",
    "",
    "Evidence pack:",
    formatEvidencePack(input.evidencePack),
    "",
    "Draft to review:",
    JSON.stringify(draft),
    "",
    `Call ${DRAFT_TOOL_NAME} with the corrected page draft (the full page, not just the changes).`,
  ].join("\n");
}
