// Job payloads for the three Gemini verification stages (plan §5,
// Steps 5–7). One BullMQ job = one Gemini call = one page's worth of
// work for that stage (batched entailment covers the whole page's
// claims in a single call — plan §5 Step 5).

export type GeminiStage = "entailment" | "banned_claim" | "rubric";

export interface EvidenceForClaim {
  id: number;
  source_type: string;
  text: string;
}

export interface EntailmentItem {
  id: string; // claim_key, e.g. "c1"
  claim: string;
  evidence: EvidenceForClaim[];
}

export interface EntailmentJobData {
  stage: "entailment";
  pageId: number;
  items: EntailmentItem[]; // capped at 25 per plan §5 Step 5
}

export interface BannedClaimJobData {
  stage: "banned_claim";
  pageId: number;
  renderedText: string;
}

export interface RubricJobData {
  stage: "rubric";
  pageId: number;
  renderedText: string;
  metaTitle: string;
  metaDescription: string;
}

export type GeminiJobData = EntailmentJobData | BannedClaimJobData | RubricJobData;

export type EntailmentVerdict = "entailed" | "partially" | "not_entailed" | "contradicted";

export interface EntailmentResultItem {
  id: string;
  verdict: EntailmentVerdict;
  confidence: number;
  reason: string;
}

export interface EntailmentResult {
  results: EntailmentResultItem[];
}

export interface BannedClaimResult {
  hit: boolean;
  rule?: string;
  offending_span?: string;
}

export interface RubricResult {
  score: number; // 0-100
  answers_query_in_first_100_words: boolean;
  has_information_beyond_metadata: boolean;
  filler_sections: string[];
}
