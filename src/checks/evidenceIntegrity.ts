// Evidence-integrity check (plan §5 Step 4): "all evidence_ids exist,
// are publishable, unexpired, not superseded." Runs before exact-match
// — a claim whose evidence fails this check is reported here, and
// exactMatch.ts silently skips value-comparison against it rather than
// duplicating the failure.
//
// Also closes a gap from the schema review: evidence_freshness_rules
// defines a `required_source` per attribute (e.g. syllabus_coverage
// must be official_exam_body) that the plan's Step 1 evidence-pack
// query never actually enforced. This check enforces it here, at the
// point a claim tries to use that evidence.

import type { CheckFailure, ClaimRow, EvidenceRow, FreshnessRule } from "./types.js";
import { claimRequiresEvidence } from "./exactMatch.js";

export function checkEvidenceIntegrity(
  claim: ClaimRow,
  evidenceById: ReadonlyMap<number, EvidenceRow>,
  freshnessRules: ReadonlyMap<string, FreshnessRule>,
  now: Date = new Date(),
): CheckFailure[] {
  if (!claimRequiresEvidence(claim.claimType)) return [];

  const fail = (code: string, message: string): CheckFailure => ({
    stage: "evidence_integrity",
    code,
    message,
    severity: "block",
    blockId: claim.blockId,
    claimId: claim.id,
  });

  if (claim.evidenceIds.length === 0) {
    return [fail("missing_evidence", `Claim ${claim.claimKey} (${claim.claimType}) has no cited evidence.`)];
  }

  const failures: CheckFailure[] = [];

  for (const evidenceId of claim.evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      failures.push(fail("evidence_not_found", `Claim ${claim.claimKey} cites evidence ${evidenceId}, which does not exist.`));
      continue;
    }
    if (evidence.deletedAt !== null) {
      failures.push(fail("evidence_deleted", `Evidence ${evidenceId} is soft-deleted.`));
      continue;
    }
    if (evidence.supersededBy !== null) {
      failures.push(fail("evidence_superseded", `Evidence ${evidenceId} has been superseded by ${evidence.supersededBy}.`));
      continue;
    }
    if (!evidence.publishable) {
      failures.push(fail("evidence_not_publishable", `Evidence ${evidenceId} is not publishable.`));
      continue;
    }

    const rule = freshnessRules.get(evidence.attribute);
    const maxAgeMs = rule?.maxAgeMs ?? 90 * 24 * 3600 * 1000; // matches freshness_window()'s SQL fallback
    const ageMs = now.getTime() - evidence.retrievedAt.getTime();
    if (ageMs > maxAgeMs) {
      failures.push(
        fail(
          "evidence_stale",
          `Evidence ${evidenceId} (${evidence.attribute}) is ${Math.round(ageMs / 86_400_000)} days old, over the ${Math.round(maxAgeMs / 86_400_000)}-day limit.`,
        ),
      );
      continue;
    }

    if (rule?.requiredSource && evidence.sourceType !== rule.requiredSource) {
      failures.push(
        fail(
          "evidence_wrong_source",
          `Evidence ${evidenceId} (${evidence.attribute}) is sourced from "${evidence.sourceType}", but this attribute requires "${rule.requiredSource}".`,
        ),
      );
    }
  }

  return failures;
}
