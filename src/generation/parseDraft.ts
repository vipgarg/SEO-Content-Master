// Defensive runtime validation of Claude's tool-call output. The
// forced tool_choice call is checked against its input_schema
// server-side, but that's JSON-shape validation only — it won't catch
// a duplicate block_key, a claim citing an evidence id that isn't in
// the pack we sent, or a numeric/date/identifier/entity/categorical
// claim with no evidence_ids (the same "descriptive is the only
// evidence-optional type" rule the checks module enforces downstream —
// enforcing it here too means a malformed draft never reaches that
// stage at all).

import type { BlockType, ClaimType, DraftBlock, DraftClaim, DraftPage } from "./types.js";

const CLAIM_TYPES: ReadonlySet<string> = new Set([
  "numeric", "date", "identifier", "entity", "categorical", "descriptive",
]);
const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "heading", "paragraph", "list", "table", "faq", "cta", "pros_cons",
]);
const EVIDENCE_OPTIONAL_TYPES: ReadonlySet<ClaimType> = new Set(["descriptive"]);

export class DraftValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Draft failed validation:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "DraftValidationError";
    this.issues = issues;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateClaim(raw: unknown, blockKey: string, index: number, issues: string[]): DraftClaim | null {
  if (!isRecord(raw)) {
    issues.push(`block ${blockKey} claim[${index}] is not an object`);
    return null;
  }
  const { claim_key, claim_text, claim_type, evidence_ids } = raw;
  const prefix = `block ${blockKey} claim[${index}]`;

  if (typeof claim_key !== "string" || claim_key.length === 0) {
    issues.push(`${prefix}: claim_key must be a non-empty string`);
    return null;
  }
  if (typeof claim_text !== "string" || claim_text.length === 0) {
    issues.push(`${prefix} (${claim_key}): claim_text must be a non-empty string`);
    return null;
  }
  if (typeof claim_type !== "string" || !CLAIM_TYPES.has(claim_type)) {
    issues.push(`${prefix} (${claim_key}): claim_type "${String(claim_type)}" is not one of ${[...CLAIM_TYPES].join(", ")}`);
    return null;
  }
  if (!Array.isArray(evidence_ids) || !evidence_ids.every((id) => typeof id === "number")) {
    issues.push(`${prefix} (${claim_key}): evidence_ids must be an array of numbers`);
    return null;
  }

  const type = claim_type as ClaimType;
  if (evidence_ids.length === 0 && !EVIDENCE_OPTIONAL_TYPES.has(type)) {
    issues.push(`${prefix} (${claim_key}): claim_type "${type}" requires at least one evidence id, got none`);
  }

  return { claim_key, claim_text, claim_type: type, evidence_ids };
}

function validateBlock(raw: unknown, index: number, issues: string[]): DraftBlock | null {
  if (!isRecord(raw)) {
    issues.push(`blocks[${index}] is not an object`);
    return null;
  }
  const { block_key, block_type, section, heading, body, is_required, claims } = raw;
  const prefix = `blocks[${index}]`;

  if (typeof block_key !== "string" || block_key.length === 0) {
    issues.push(`${prefix}: block_key must be a non-empty string`);
    return null;
  }
  if (typeof block_type !== "string" || !BLOCK_TYPES.has(block_type)) {
    issues.push(`${prefix} (${block_key}): block_type "${String(block_type)}" is not one of ${[...BLOCK_TYPES].join(", ")}`);
    return null;
  }
  if (typeof body !== "string" || body.length === 0) {
    issues.push(`${prefix} (${block_key}): body must be a non-empty string`);
    return null;
  }
  if (section !== null && typeof section !== "string") {
    issues.push(`${prefix} (${block_key}): section must be a string or null`);
  }
  if (heading !== null && typeof heading !== "string") {
    issues.push(`${prefix} (${block_key}): heading must be a string or null`);
  }
  if (typeof is_required !== "boolean") {
    issues.push(`${prefix} (${block_key}): is_required must be a boolean`);
  }
  if (!Array.isArray(claims)) {
    issues.push(`${prefix} (${block_key}): claims must be an array`);
    return null;
  }

  const parsedClaims: DraftClaim[] = [];
  claims.forEach((c, i) => {
    const claim = validateClaim(c, block_key, i, issues);
    if (claim) parsedClaims.push(claim);
  });

  return {
    block_key,
    block_type: block_type as BlockType,
    section: (section as string | null) ?? null,
    heading: (heading as string | null) ?? null,
    body,
    is_required: Boolean(is_required),
    claims: parsedClaims,
  };
}

export function parseDraftPage(raw: unknown): DraftPage {
  const issues: string[] = [];

  if (!isRecord(raw)) {
    throw new DraftValidationError(["draft is not an object"]);
  }
  const { meta_title, meta_description, blocks, unsupported_flags } = raw;

  if (typeof meta_title !== "string" || meta_title.length === 0) {
    issues.push("meta_title must be a non-empty string");
  }
  if (typeof meta_description !== "string" || meta_description.length === 0) {
    issues.push("meta_description must be a non-empty string");
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    issues.push("blocks must be a non-empty array");
    throw new DraftValidationError(issues); // nothing further to check without blocks
  }
  if (unsupported_flags !== undefined && (!Array.isArray(unsupported_flags) || !unsupported_flags.every((f) => typeof f === "string"))) {
    issues.push("unsupported_flags, if present, must be an array of strings");
  }

  const parsedBlocks: DraftBlock[] = [];
  blocks.forEach((b, i) => {
    const block = validateBlock(b, i, issues);
    if (block) parsedBlocks.push(block);
  });

  const blockKeys = parsedBlocks.map((b) => b.block_key);
  const duplicateBlockKeys = blockKeys.filter((k, i) => blockKeys.indexOf(k) !== i);
  if (duplicateBlockKeys.length > 0) {
    issues.push(`duplicate block_key(s): ${[...new Set(duplicateBlockKeys)].join(", ")}`);
  }

  const claimKeys = parsedBlocks.flatMap((b) => b.claims.map((c) => c.claim_key));
  const duplicateClaimKeys = claimKeys.filter((k, i) => claimKeys.indexOf(k) !== i);
  if (duplicateClaimKeys.length > 0) {
    issues.push(`duplicate claim_key(s) across the page: ${[...new Set(duplicateClaimKeys)].join(", ")}`);
  }

  if (issues.length > 0) {
    throw new DraftValidationError(issues);
  }

  return {
    meta_title: meta_title as string,
    meta_description: meta_description as string,
    blocks: parsedBlocks,
    unsupported_flags: (unsupported_flags as string[] | undefined) ?? [],
  };
}

/** Claims whose evidence_ids reference ids not present in the evidence pack sent for this draft — a Claude hallucination, not a schema-shape problem. */
export function findUnknownEvidenceReferences(
  draft: DraftPage,
  knownEvidenceIds: ReadonlySet<number>,
): string[] {
  const problems: string[] = [];
  for (const block of draft.blocks) {
    for (const claim of block.claims) {
      for (const evidenceId of claim.evidence_ids) {
        if (!knownEvidenceIds.has(evidenceId)) {
          problems.push(
            `block ${block.block_key} claim ${claim.claim_key} cites evidence id ${evidenceId}, which was not in the evidence pack sent to the model`,
          );
        }
      }
    }
  }
  return problems;
}
