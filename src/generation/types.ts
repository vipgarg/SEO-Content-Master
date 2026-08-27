// The structured JSON contract between Claude and this pipeline. v2 §7
// (the canonical spec for this shape) wasn't available when this was
// written — this is inferred from schema-v4.1.sql's page_blocks/
// claims/claim_evidence tables plus plan §5 Step 2's prose
// requirements ("any sentence containing a number, date, edition, exam
// name or superlative must carry a claim object... unsourceable goes
// in unsupported_flags, not the prose"). Treat this file as the thing
// to reconcile against v2 §7 once it's available, not as settled.

export type ClaimType = "numeric" | "date" | "identifier" | "entity" | "categorical" | "descriptive";
export type BlockType = "heading" | "paragraph" | "list" | "table" | "faq" | "cta" | "pros_cons";

export interface DraftClaim {
  claim_key: string; // "c1" — unique within the page
  claim_text: string;
  claim_type: ClaimType;
  /** Evidence row ids this claim is grounded in. Empty only allowed for claim_type "descriptive". */
  evidence_ids: number[];
}

export interface DraftBlock {
  block_key: string; // "b1" — unique within the page, matches page_blocks.block_key
  block_type: BlockType;
  section: string | null; // maps to the brief's outline section
  heading: string | null;
  body: string;
  is_required: boolean;
  claims: DraftClaim[];
}

export interface DraftPage {
  meta_title: string;
  meta_description: string;
  blocks: DraftBlock[];
  /** The model's own admission of facts it could not source — plan §5 Step 2: goes here, never into prose. */
  unsupported_flags: string[];
}

export interface EvidencePackItem {
  id: number;
  attribute: string;
  valueText: string | null;
  valueNum: number | null;
  valueDate: string | null;
  sourceType: string;
}

export interface GenerationBrief {
  pageType: string;
  outline: unknown; // content_briefs.outline JSONB — ordered sections, required/optional, word budgets
  wordBudgetMin: number;
  wordBudgetMax: number;
  minEvidence: number;
  descriptiveRatioMax: number;
  faqCountMin: number;
  faqCountMax: number;
}

export interface GenerationInput {
  pageId: number;
  brief: GenerationBrief;
  evidencePack: EvidencePackItem[];
  styleGuide: string;
  bannedPhrases: readonly string[];
}

export interface GenerationResult {
  draft: DraftPage;
  /** The pre-self-critique draft, kept for audit/comparison — not persisted as a separate page state, just returned. */
  initialDraft: DraftPage;
  draftModel: string;
  inputTokens: number;
  outputTokens: number;
}
