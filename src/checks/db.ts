// The only file in src/checks/ that touches Postgres. Loads a page's
// data into the plain types runDeterministicChecks.ts operates on, and
// persists its result back to verification_runs / seo_audits /
// page_blocks / pages. Everything else in this directory is pure and
// tested without a database at all.

import type { Pool } from "pg";
import type {
  BlockRow,
  ClaimRow,
  ClaimType,
  CorpusPage,
  EvidenceRow,
  FreshnessRule,
  PageDraft,
} from "./types.js";
import type { DeterministicChecksResult } from "./runDeterministicChecks.js";

interface PgInterval {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

/** Approximate — freshness windows in this schema are all days/hours, never months/years, so the approximation never actually applies. */
function intervalToMs(interval: PgInterval): number {
  const years = interval.years ?? 0;
  const months = interval.months ?? 0;
  const days = interval.days ?? 0;
  const hours = interval.hours ?? 0;
  const minutes = interval.minutes ?? 0;
  const seconds = interval.seconds ?? 0;
  const milliseconds = interval.milliseconds ?? 0;
  return (
    ((years * 365 + months * 30 + days) * 24 * 3600 + hours * 3600 + minutes * 60 + seconds) * 1000 +
    milliseconds
  );
}

export async function loadPageDraft(pool: Pool, pageId: number): Promise<PageDraft> {
  const pageResult = await pool.query<{ meta_title: string | null; meta_description: string | null }>(
    "SELECT meta_title, meta_description FROM pages WHERE id = $1",
    [pageId],
  );
  const page = pageResult.rows[0];
  if (!page) throw new Error(`Page ${pageId} not found`);

  const blocksResult = await pool.query<{
    id: number;
    block_key: string;
    position: number;
    block_type: string;
    heading: string | null;
    body: string | null;
    is_required: boolean;
  }>(
    `SELECT id, block_key, position, block_type, heading, body, is_required
     FROM page_blocks WHERE page_id = $1 ORDER BY position`,
    [pageId],
  );
  const blocks: BlockRow[] = blocksResult.rows.map((r) => ({
    id: r.id,
    blockKey: r.block_key,
    position: r.position,
    blockType: r.block_type,
    heading: r.heading,
    body: r.body ?? "",
    isRequired: r.is_required,
  }));

  const claimsResult = await pool.query<{
    id: number;
    block_id: number;
    claim_key: string;
    claim_text: string;
    claim_type: ClaimType;
    evidence_ids: number[];
  }>(
    // Cast to int[] (not left as the natural bigint[]): pg parses
    // int4 arrays into number[] out of the box, but bigint arrays
    // into string[] (same reason scalar bigint needs typeParsers.ts —
    // it just doesn't cover arrays, a different OID). Evidence ids
    // won't approach int4's ~2.1 billion range in this application.
    `SELECT c.id, c.block_id, c.claim_key, c.claim_text, c.claim_type,
            COALESCE(array_remove(array_agg(ce.evidence_id), NULL), '{}')::int[] AS evidence_ids
     FROM claims c
     LEFT JOIN claim_evidence ce ON ce.claim_id = c.id
     WHERE c.page_id = $1
     GROUP BY c.id
     ORDER BY c.id`,
    [pageId],
  );
  const claims: ClaimRow[] = claimsResult.rows.map((r) => ({
    id: r.id,
    blockId: r.block_id,
    claimKey: r.claim_key,
    claimText: r.claim_text,
    claimType: r.claim_type,
    evidenceIds: r.evidence_ids,
  }));

  return {
    pageId,
    metaTitle: page.meta_title ?? "",
    metaDescription: page.meta_description ?? "",
    blocks,
    claims,
  };
}

export async function loadEvidenceByIds(
  pool: Pool,
  ids: readonly number[],
): Promise<Map<number, EvidenceRow>> {
  const map = new Map<number, EvidenceRow>();
  if (ids.length === 0) return map;
  const { rows } = await pool.query<{
    id: number;
    entity_type: string;
    entity_id: number;
    attribute: string;
    value_text: string | null;
    value_num: string | null; // NUMERIC comes back as string from pg
    value_date: string | null;
    value_bool: boolean | null;
    source_type: string;
    publishable: boolean;
    retrieved_at: Date;
    superseded_by: number | null;
    deleted_at: Date | null;
  }>(
    `SELECT id, entity_type, entity_id, attribute, value_text, value_num, value_date, value_bool,
            source_type, publishable, retrieved_at, superseded_by, deleted_at
     FROM evidence WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      attribute: r.attribute,
      valueText: r.value_text,
      valueNum: r.value_num !== null ? Number.parseFloat(r.value_num) : null,
      valueDate: r.value_date, // pg returns DATE as "YYYY-MM-DD" string when no time component
      valueBool: r.value_bool,
      sourceType: r.source_type,
      publishable: r.publishable,
      retrievedAt: r.retrieved_at,
      supersededBy: r.superseded_by,
      deletedAt: r.deleted_at,
    });
  }
  return map;
}

export async function loadFreshnessRules(pool: Pool): Promise<Map<string, FreshnessRule>> {
  const { rows } = await pool.query<{
    attribute: string;
    max_age: PgInterval;
    required_source: string | null;
  }>("SELECT attribute, max_age, required_source FROM evidence_freshness_rules");
  const map = new Map<string, FreshnessRule>();
  for (const r of rows) {
    map.set(r.attribute, { maxAgeMs: intervalToMs(r.max_age), requiredSource: r.required_source });
  }
  return map;
}

/**
 * Every published page except `excludePageId`, as corpus text (blocks'
 * bodies concatenated) plus the "attribute:value" fact set its own
 * numeric/date/identifier/entity/categorical claims assert. Category is
 * derived via the primary entity's work→category when resolvable, else
 * "unknown" — pages aren't all books, and not every primary_entity_type
 * has a category concept, so this is a best-effort grouping for the
 * information-gain check, not a strict taxonomy.
 */
export async function loadCorpusPages(pool: Pool, excludePageId: number): Promise<CorpusPage[]> {
  const { rows: pageRows } = await pool.query<{
    id: number;
    category_slug: string | null;
  }>(
    `SELECT p.id,
            CASE WHEN p.primary_entity_type = 'work' THEN cat.slug ELSE NULL END AS category_slug
     FROM pages p
     LEFT JOIN works w ON w.id = p.primary_entity_id AND p.primary_entity_type = 'work'
     LEFT JOIN categories cat ON cat.id = w.category_id
     WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.id <> $1`,
    [excludePageId],
  );
  if (pageRows.length === 0) return [];

  const pageIds = pageRows.map((r) => r.id);

  const { rows: textRows } = await pool.query<{ page_id: number; text: string }>(
    `SELECT page_id, string_agg(body, ' ' ORDER BY position) AS text
     FROM page_blocks WHERE page_id = ANY($1::bigint[]) GROUP BY page_id`,
    [pageIds],
  );
  const textByPage = new Map(textRows.map((r) => [r.page_id, r.text ?? ""]));

  const { rows: factRows } = await pool.query<{
    page_id: number;
    attribute: string;
    value_text: string | null;
    value_num: string | null;
  }>(
    `SELECT c.page_id, e.attribute, e.value_text, e.value_num
     FROM claims c
     JOIN claim_evidence ce ON ce.claim_id = c.id
     JOIN evidence e ON e.id = ce.evidence_id
     WHERE c.page_id = ANY($1::bigint[])
       AND c.claim_type IN ('numeric','date','identifier','entity','categorical')`,
    [pageIds],
  );
  const factsByPage = new Map<number, Set<string>>();
  for (const r of factRows) {
    const value = r.value_text ?? r.value_num ?? "";
    const set = factsByPage.get(r.page_id) ?? new Set<string>();
    set.add(`${r.attribute}:${value}`);
    factsByPage.set(r.page_id, set);
  }

  return pageRows.map((r) => ({
    pageId: r.id,
    text: textByPage.get(r.id) ?? "",
    category: r.category_slug ?? "unknown",
    facts: factsByPage.get(r.id) ?? new Set<string>(),
  }));
}

export function categoryFactsFor(corpusPages: readonly CorpusPage[], category: string): Set<string> {
  const facts = new Set<string>();
  for (const page of corpusPages) {
    if (page.category !== category) continue;
    for (const fact of page.facts) facts.add(fact);
  }
  return facts;
}

/**
 * Persists a full check run: one verification_runs row per stage
 * (provider='none' — these are the free deterministic checks, no
 * model involved), one seo_audits row, and updates pages.status /
 * page_blocks.regenerated_count to reflect the routing decision.
 *
 * Does NOT trigger regeneration itself — that's the generation
 * pipeline's job (not built yet). This only records what needs it.
 */
export async function persistCheckResults(
  pool: Pool,
  pageId: number,
  result: DeterministicChecksResult,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const stageResult of result.stageResults) {
      await client.query(
        `INSERT INTO verification_runs (page_id, stage, provider, passed, failure_reason)
         VALUES ($1, $2, 'none', $3, $4)`,
        [
          pageId,
          stageResult.stage,
          stageResult.passed,
          stageResult.passed ? null : JSON.stringify(stageResult.failures),
        ],
      );
    }

    const audit = result.seoAudit;
    await client.query(
      `INSERT INTO seo_audits
         (page_id, h1_count, h2_count, meta_title_len, meta_desc_len, internal_links, faq_count,
          duplicate_max_similarity, duplicate_against_page_id,
          templated_sentence_ratio, metadata_only_word_count, information_gain_score, thin_content_flag,
          score, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        pageId,
        audit.h1Count,
        audit.h2Count,
        audit.metaTitleLen,
        audit.metaDescLen,
        audit.internalLinks,
        audit.faqCount,
        audit.duplicateMaxSimilarity,
        audit.duplicateAgainstPageId,
        audit.templatedSentenceRatio,
        audit.metadataOnlyWordCount,
        audit.informationGainScore,
        audit.thinContentFlag,
        result.passed ? 100 : 0, // placeholder score — real scoring is the rubric's job (plan §5 Step 7), not this pass/fail gate
        JSON.stringify({ failureCount: result.allFailures.length }),
      ],
    );

    if (result.blocksToRegenerate.size > 0) {
      await client.query(
        `UPDATE page_blocks SET regenerated_count = regenerated_count + 1
         WHERE page_id = $1 AND id = ANY($2::bigint[])`,
        [pageId, [...result.blocksToRegenerate]],
      );
    }

    const newStatus = result.passed ? "checks_passed" : "needs_review";
    await client.query("UPDATE pages SET status = $1, updated_at = now() WHERE id = $2", [
      newStatus,
      pageId,
    ]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
