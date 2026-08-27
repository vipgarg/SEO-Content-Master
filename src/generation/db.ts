// The only file in src/generation/ that touches Postgres: assembles
// the evidence pack (plan §5 Step 1), loads a brief, persists a
// generated/self-critiqued draft, and orchestrates the gate between
// them (insufficient evidence → evidence_gaps, never a generation call).

import type { Pool } from "pg";
import type { DraftPage, EvidencePackItem, GenerationBrief } from "./types.js";
import { generateDraft, type GenerateDraftDeps } from "./generateDraft.js";

/**
 * Plan §5 Step 1's evidence-pack query, extended to also enforce
 * evidence_freshness_rules.required_source — the same gap closed in
 * src/checks/evidenceIntegrity.ts, closed here too so a draft is never
 * handed evidence that would fail that check anyway. Belt and
 * suspenders deliberately: assembly filtering it out means Claude never
 * sees the bad row; the checks stage catches it if this ever drifts.
 */
export async function loadEvidencePack(
  pool: Pool,
  entityType: string,
  entityId: number,
): Promise<EvidencePackItem[]> {
  const { rows } = await pool.query<{
    id: number;
    attribute: string;
    value_text: string | null;
    value_num: string | null;
    value_date: string | null;
    source_type: string;
  }>(
    `SELECT e.id, e.attribute, e.value_text, e.value_num, e.value_date, e.source_type
     FROM evidence e
     LEFT JOIN evidence_freshness_rules r ON r.attribute = e.attribute
     WHERE e.entity_type = $1
       AND e.entity_id = $2
       AND e.publishable = true
       AND e.deleted_at IS NULL
       AND e.superseded_by IS NULL
       AND e.retrieved_at > now() - freshness_window(e.attribute)
       AND (r.required_source IS NULL OR e.source_type = r.required_source)
     ORDER BY e.attribute`,
    [entityType, entityId],
  );
  return rows.map((r) => ({
    id: r.id,
    attribute: r.attribute,
    valueText: r.value_text,
    valueNum: r.value_num !== null ? Number.parseFloat(r.value_num) : null,
    valueDate: r.value_date,
    sourceType: r.source_type,
  }));
}

export async function loadBrief(pool: Pool, briefId: number): Promise<GenerationBrief> {
  const { rows } = await pool.query<{
    page_type: string;
    outline: unknown;
    word_budget_min: number;
    word_budget_max: number;
    min_evidence: number;
    descriptive_ratio_max: string;
    faq_count_min: number;
    faq_count_max: number;
  }>(
    `SELECT page_type, outline, word_budget_min, word_budget_max, min_evidence,
            descriptive_ratio_max, faq_count_min, faq_count_max
     FROM content_briefs WHERE id = $1`,
    [briefId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Brief ${briefId} not found`);
  return {
    pageType: row.page_type,
    outline: row.outline,
    wordBudgetMin: row.word_budget_min,
    wordBudgetMax: row.word_budget_max,
    minEvidence: row.min_evidence,
    descriptiveRatioMax: Number.parseFloat(row.descriptive_ratio_max),
    faqCountMin: row.faq_count_min,
    faqCountMax: row.faq_count_max,
  };
}

/**
 * Records an evidence gap for every attribute a freshness rule names
 * that this entity has no valid row for — best-effort: it only flags
 * attributes we have a rule for, since those are the only ones we know
 * to expect. `blocking` is left true (schema default): plan §5 Step 1
 * says the page simply isn't generated below min_evidence, and every
 * gap on the entity that's stopping that counts as blocking.
 */
export async function recordEvidenceGaps(
  pool: Pool,
  entityType: string,
  entityId: number,
  missingAttributes: readonly string[],
): Promise<void> {
  for (const attribute of missingAttributes) {
    await pool.query(
      `INSERT INTO evidence_gaps (entity_type, entity_id, attribute, reason)
       VALUES ($1, $2, $3, 'missing')
       ON CONFLICT (entity_type, entity_id, attribute) DO NOTHING`,
      [entityType, entityId, attribute],
    );
  }
}

/**
 * Replaces a page's blocks/claims/claim_evidence with a generated
 * draft and advances its status. Delete-then-insert rather than a
 * diff/upsert — regeneration of an existing page is expected to fully
 * replace its content, and block_key/claim_key are only meaningful
 * within one generation, not stable identifiers across runs.
 */
export async function persistDraft(
  pool: Pool,
  pageId: number,
  draft: DraftPage,
  status: "generated" | "self_critiqued",
  generatorModel: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM page_blocks WHERE page_id = $1", [pageId]); // cascades to claims, claim_evidence

    const blockIdByKey = new Map<string, number>();
    for (const [index, block] of draft.blocks.entries()) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO page_blocks (page_id, block_key, position, block_type, section, heading, body, is_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [pageId, block.block_key, index + 1, block.block_type, block.section, block.heading, block.body, block.is_required],
      );
      blockIdByKey.set(block.block_key, rows[0]!.id);
    }

    for (const block of draft.blocks) {
      const blockId = blockIdByKey.get(block.block_key)!;
      for (const claim of block.claims) {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO claims (page_id, block_id, claim_key, claim_text, claim_type)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [pageId, blockId, claim.claim_key, claim.claim_text, claim.claim_type],
        );
        const claimId = rows[0]!.id;
        for (const evidenceId of claim.evidence_ids) {
          await client.query(
            "INSERT INTO claim_evidence (claim_id, evidence_id) VALUES ($1, $2)",
            [claimId, evidenceId],
          );
        }
      }
    }

    await client.query("DELETE FROM unsupported_flags WHERE page_id = $1", [pageId]);
    for (const note of draft.unsupported_flags) {
      await client.query("INSERT INTO unsupported_flags (page_id, note) VALUES ($1, $2)", [pageId, note]);
    }

    const wordCount = draft.blocks.reduce((sum, b) => sum + b.body.split(/\s+/).filter(Boolean).length, 0);
    await client.query(
      `UPDATE pages
       SET meta_title = $1, meta_description = $2, status = $3, generator_model = $4,
           generated_at = COALESCE(generated_at, now()), word_count = $5, updated_at = now()
       WHERE id = $6`,
      [draft.meta_title, draft.meta_description, status, generatorModel, wordCount, pageId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface RunGenerationResult {
  outcome: "generated" | "evidence_gap";
  pack?: EvidencePackItem[];
}

/**
 * Full plan §5 Steps 1–3 for one page: assemble the evidence pack, gate
 * on min_evidence (routing to the evidence gap queue rather than
 * calling Claude at all if there isn't enough), otherwise draft +
 * self-critique + persist. Mirrors runDeterministicChecks/db.ts's
 * split — this function is the only thing that needs both the pure
 * generateDraft and the DB, so it lives here rather than forcing a
 * pure orchestrator to accept a DB handle.
 */
export async function runGeneration(
  pool: Pool,
  pageId: number,
  entityType: string,
  entityId: number,
  briefId: number,
  styleGuide: string,
  bannedPhrases: readonly string[],
  deps: GenerateDraftDeps,
): Promise<RunGenerationResult> {
  const brief = await loadBrief(pool, briefId);
  const pack = await loadEvidencePack(pool, entityType, entityId);

  if (pack.length < brief.minEvidence) {
    await recordEvidenceGaps(
      pool,
      entityType,
      entityId,
      [...new Set((await pool.query<{ attribute: string }>("SELECT attribute FROM evidence_freshness_rules")).rows.map((r) => r.attribute))].filter(
        (attribute) => !pack.some((item) => item.attribute === attribute),
      ),
    );
    return { outcome: "evidence_gap", pack };
  }

  const result = await generateDraft(
    { pageId, brief, evidencePack: pack, styleGuide, bannedPhrases },
    deps,
  );
  await persistDraft(pool, pageId, result.draft, "self_critiqued", result.draftModel);
  return { outcome: "generated", pack };
}
