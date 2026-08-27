// Numeric/date/identifier/entity exact-match check (plan §5 Step 4):
// "extract every number, date, ISBN, edition year, author and
// publisher string from the rendered text; each must equal its cited
// evidence value exactly. Zero tolerance on identifiers and dates."
//
// Every claim of type numeric/date/identifier/entity/categorical must
// carry at least one evidence row (schema §A.5, extended in
// schema-v4.1.sql to include categorical alongside the original four —
// superlatives are categorical claims and need sourcing too).
// `descriptive` claims are exempt and never checked here.

import type { CheckFailure, ClaimRow, EvidenceRow } from "./types.js";
import {
  extractDates,
  extractIsbns,
  extractNumbers,
  normalizeEntityText,
} from "./textExtraction.js";

const REQUIRES_EVIDENCE: ReadonlySet<ClaimRow["claimType"]> = new Set([
  "numeric",
  "date",
  "identifier",
  "entity",
  "categorical",
]);

export function claimRequiresEvidence(claimType: ClaimRow["claimType"]): boolean {
  return REQUIRES_EVIDENCE.has(claimType);
}

function normalizeIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Checks one claim against its cited evidence rows. Returns the list
 * of failures (empty = passed). `evidenceById` must contain every id
 * the claim references — missing ids are the evidence-integrity
 * check's job (evidenceIntegrity.ts), not this one; this function
 * assumes referential integrity already holds and focuses purely on
 * value equality.
 */
export function checkClaimExactMatch(
  claim: ClaimRow,
  evidenceById: ReadonlyMap<number, EvidenceRow>,
): CheckFailure[] {
  if (!claimRequiresEvidence(claim.claimType)) return [];

  if (claim.evidenceIds.length === 0) {
    return [
      {
        stage: "exact_match",
        code: "missing_evidence",
        message: `Claim ${claim.claimKey} (${claim.claimType}) has no cited evidence.`,
        severity: "block",
        blockId: claim.blockId,
        claimId: claim.id,
      },
    ];
  }

  const failures: CheckFailure[] = [];

  for (const evidenceId of claim.evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      // Referential-integrity failure — evidenceIntegrity.ts owns
      // reporting this; skip value-matching against data we don't have.
      continue;
    }
    const failure = checkOneClaimAgainstOneEvidence(claim, evidence);
    if (failure) failures.push(failure);
  }

  return failures;
}

function checkOneClaimAgainstOneEvidence(
  claim: ClaimRow,
  evidence: EvidenceRow,
): CheckFailure | undefined {
  const fail = (code: string, message: string): CheckFailure => ({
    stage: "exact_match",
    code,
    message,
    severity: "block",
    blockId: claim.blockId,
    claimId: claim.id,
  });

  switch (claim.claimType) {
    case "numeric": {
      if (evidence.valueNum === null) return fail("no_numeric_evidence_value", `Evidence ${evidence.id} has no value_num.`);
      const candidates = extractNumbers(claim.claimText);
      if (candidates.length === 0) {
        return fail("no_number_in_text", `Claim "${claim.claimText}" cites a numeric evidence row but contains no number.`);
      }
      const matches = candidates.some((n) => n === evidence.valueNum);
      if (!matches) {
        return fail(
          "numeric_mismatch",
          `Claim "${claim.claimText}" contains [${candidates.join(", ")}], none equal to evidence value ${evidence.valueNum}.`,
        );
      }
      return undefined;
    }

    case "date": {
      if (evidence.valueDate === null) return fail("no_date_evidence_value", `Evidence ${evidence.id} has no value_date.`);
      const candidates = extractDates(claim.claimText);
      if (candidates.length === 0) {
        return fail("no_date_in_text", `Claim "${claim.claimText}" cites a date evidence row but contains no recognizable date.`);
      }
      if (!candidates.includes(evidence.valueDate)) {
        return fail(
          "date_mismatch",
          `Claim "${claim.claimText}" contains dates [${candidates.join(", ")}], none equal to evidence value ${evidence.valueDate}.`,
        );
      }
      return undefined;
    }

    case "identifier": {
      if (!evidence.valueText) return fail("no_identifier_evidence_value", `Evidence ${evidence.id} has no value_text.`);
      const expected = normalizeIsbn(evidence.valueText);
      const candidates = extractIsbns(claim.claimText);
      if (candidates.length === 0) {
        return fail("no_identifier_in_text", `Claim "${claim.claimText}" cites an identifier evidence row but contains no ISBN-shaped string.`);
      }
      if (!candidates.includes(expected)) {
        return fail(
          "identifier_mismatch",
          `Claim "${claim.claimText}" contains [${candidates.join(", ")}], none equal to evidence value ${expected}.`,
        );
      }
      return undefined;
    }

    case "entity":
    case "categorical": {
      if (!evidence.valueText) return fail("no_entity_evidence_value", `Evidence ${evidence.id} has no value_text.`);
      const normalizedClaim = normalizeEntityText(claim.claimText);
      const normalizedEvidence = normalizeEntityText(evidence.valueText);
      if (normalizedEvidence.length === 0) return undefined; // nothing to check against
      if (!normalizedClaim.includes(normalizedEvidence)) {
        return fail(
          "entity_mismatch",
          `Claim "${claim.claimText}" does not contain evidence value "${evidence.valueText}".`,
        );
      }
      return undefined;
    }

    case "descriptive":
      return undefined;
  }
}
