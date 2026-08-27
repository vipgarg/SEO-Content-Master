// Shared types for the deterministic-checks pipeline (plan §5 Step 4,
// §4a). Deliberately DB-shaped-but-DB-free: these are plain data the
// pure check functions operate on, loaded from Postgres by
// src/checks/db.ts and never touched directly by the checks themselves
// — the same split that worked well for the gemini worker.

export type ClaimType = "numeric" | "date" | "identifier" | "entity" | "categorical" | "descriptive";

export interface EvidenceRow {
  id: number;
  entityType: string;
  entityId: number;
  attribute: string;
  valueText: string | null;
  valueNum: number | null;
  valueDate: string | null; // ISO "YYYY-MM-DD"
  valueBool: boolean | null;
  sourceType: string;
  publishable: boolean;
  retrievedAt: Date;
  supersededBy: number | null;
  deletedAt: Date | null;
}

export interface ClaimRow {
  id: number;
  blockId: number;
  claimKey: string;
  claimText: string;
  claimType: ClaimType;
  evidenceIds: number[];
}

export interface BlockRow {
  id: number;
  blockKey: string;
  position: number;
  blockType: string;
  heading: string | null;
  body: string;
  isRequired: boolean;
}

export interface FreshnessRule {
  maxAgeMs: number;
  requiredSource: string | null;
}

export interface PageDraft {
  pageId: number;
  metaTitle: string;
  metaDescription: string;
  blocks: BlockRow[];
  claims: ClaimRow[];
}

/**
 * Structural facts about how the page renders — normally the Astro
 * renderer's job to compute, not built yet. Passed in explicitly so
 * the SEO-structure check is testable without a renderer.
 */
export interface RenderedStructure {
  h1Count: number;
  h2Count: number;
  internalLinkCount: number;
  faqCount: number;
}

export type CheckSeverity = "block" | "page"; // scope of what a failure invalidates

export interface CheckFailure {
  stage: DeterministicStage;
  code: string;
  message: string;
  severity: CheckSeverity;
  blockId?: number;
  claimId?: number;
}

export type DeterministicStage =
  | "evidence_integrity"
  | "exact_match"
  | "seo_structure"
  | "banned_phrase"
  | "duplicate"
  | "thin_content";

export interface StageResult {
  stage: DeterministicStage;
  passed: boolean;
  failures: CheckFailure[];
}

export interface CorpusPage {
  pageId: number;
  text: string;
  category: string;
  facts: Set<string>; // "attribute:value" strings actually asserted on that page
}
