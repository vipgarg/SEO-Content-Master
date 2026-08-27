// Integration test for src/checks/db.ts against a real Postgres
// instance — proves the loaders produce data runDeterministicChecks
// actually accepts, and that persistCheckResults writes rows matching
// what the schema expects (including the columns fixed in migrations
// 013/014 this session).

import "dotenv/config";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  categoryFactsFor,
  loadCorpusPages,
  loadEvidenceByIds,
  loadFreshnessRules,
  loadPageDraft,
  persistCheckResults,
} from "../../src/checks/db.js";
import { runDeterministicChecks } from "../../src/checks/runDeterministicChecks.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let idCounter = 2_000_000 + Math.floor(Math.random() * 5_000_000);
function nextId(): number {
  return idCounter++;
}

async function makeWork(categorySlug: string): Promise<number> {
  const catResult = await pool.query<{ id: number }>(
    `INSERT INTO categories (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [categorySlug, categorySlug],
  );
  const categoryId = catResult.rows[0]!.id;
  const n = nextId();
  const workResult = await pool.query<{ id: number }>(
    `INSERT INTO works (canonical_title, slug, category_id) VALUES ($1, $2, $3) RETURNING id`,
    [`Test Work ${n}`, `test-work-${n}`, categoryId],
  );
  return workResult.rows[0]!.id;
}

async function makePage(
  workId: number,
  status: string,
  metaTitle: string,
  metaDescription: string,
): Promise<number> {
  const n = nextId();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO pages (page_type, slug, primary_entity_type, primary_entity_id, meta_title, meta_description, status)
     VALUES ('book', $1, 'work', $2, $3, $4, $5) RETURNING id`,
    [`test-page-${n}`, workId, metaTitle, metaDescription, status],
  );
  return result.rows[0]!.id;
}

async function makeBlock(pageId: number, position: number, body: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO page_blocks (page_id, block_key, position, block_type, body, is_required)
     VALUES ($1, $2, $3, 'paragraph', $4, true) RETURNING id`,
    [pageId, `b${position}`, position, body],
  );
  return result.rows[0]!.id;
}

async function makeEvidence(workId: number, attribute: string, valueNum: number | null, valueText: string | null): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO evidence (entity_type, entity_id, attribute, value_num, value_text, source_type, source_url, retrieved_at, confidence, publishable)
     VALUES ('work', $1, $2, $3, $4, 'publisher', 'https://example.com', now(), 0.9, true) RETURNING id`,
    [workId, attribute, valueNum, valueText],
  );
  return result.rows[0]!.id;
}

async function makeClaim(pageId: number, blockId: number, claimKey: string, claimText: string, claimType: string, evidenceIds: number[]): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO claims (page_id, block_id, claim_key, claim_text, claim_type) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [pageId, blockId, claimKey, claimText, claimType],
  );
  const claimId = result.rows[0]!.id;
  for (const evidenceId of evidenceIds) {
    await pool.query(`INSERT INTO claim_evidence (claim_id, evidence_id) VALUES ($1, $2)`, [claimId, evidenceId]);
  }
  return claimId;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM pages WHERE slug LIKE 'test-page-%'");
  await pool.query("DELETE FROM works WHERE slug LIKE 'test-work-%'");
  await pool.query("DELETE FROM categories WHERE slug LIKE 'thin-content-test%'");
}

describe("checks/db (integration)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("loadPageDraft round-trips blocks and claims with their evidence ids", async () => {
    const workId = await makeWork("thin-content-test-cat-1");
    const pageId = await makePage(workId, "generated", "Test Title", "Test description.");
    const blockId = await makeBlock(pageId, 1, "The 2025 edition runs to 812 pages.");
    const evidenceId = await makeEvidence(workId, "page_count", 812, null);
    await makeClaim(pageId, blockId, "c1", "The 2025 edition runs to 812 pages.", "numeric", [evidenceId]);

    const draft = await loadPageDraft(pool, pageId);
    expect(draft.metaTitle).toBe("Test Title");
    expect(draft.blocks).toHaveLength(1);
    expect(draft.claims).toHaveLength(1);
    expect(draft.claims[0]?.evidenceIds).toEqual([evidenceId]);
  });

  it("loadEvidenceByIds returns typed rows with dates/numbers converted", async () => {
    const workId = await makeWork("thin-content-test-cat-2");
    const evidenceId = await makeEvidence(workId, "page_count", 812, null);
    const map = await loadEvidenceByIds(pool, [evidenceId]);
    const row = map.get(evidenceId);
    expect(row?.valueNum).toBe(812);
    expect(row?.publishable).toBe(true);
    expect(row?.retrievedAt).toBeInstanceOf(Date);
  });

  it("loadFreshnessRules parses Postgres INTERVAL into milliseconds correctly", async () => {
    const rules = await loadFreshnessRules(pool);
    const pageCountRule = rules.get("page_count");
    expect(pageCountRule?.maxAgeMs).toBe(365 * 24 * 3600 * 1000);
    expect(pageCountRule?.requiredSource).toBe("publisher");
    const priceRule = rules.get("our_price");
    expect(priceRule?.maxAgeMs).toBe(24 * 3600 * 1000);
  });

  it("loadCorpusPages excludes the current page and includes only published pages", async () => {
    // pages carries a unique index on (primary_entity_type,
    // primary_entity_id, page_type, secondary_entity_id) — one work per
    // page here, same as makePage's other callers throughout this file.
    const publishedPageId = await makePage(await makeWork("thin-content-test-cat-3a"), "published", "Published", "desc");
    await makeBlock(publishedPageId, 1, "Published page body text.");
    const draftPageId = await makePage(await makeWork("thin-content-test-cat-3b"), "draft", "Draft", "desc");
    await makeBlock(draftPageId, 1, "Draft page body text.");
    const currentPageId = await makePage(await makeWork("thin-content-test-cat-3c"), "published", "Current", "desc");

    const corpus = await loadCorpusPages(pool, currentPageId);
    const ids = corpus.map((p) => p.pageId);
    expect(ids).toContain(publishedPageId);
    expect(ids).not.toContain(draftPageId); // not published
    expect(ids).not.toContain(currentPageId); // excluded explicitly
  });

  it("loadCorpusPages derives category from the work's category_id and collects claim facts", async () => {
    const workId = await makeWork("thin-content-test-cat-4");
    const pageId = await makePage(workId, "published", "T", "d");
    const blockId = await makeBlock(pageId, 1, "812 pages.");
    const evidenceId = await makeEvidence(workId, "page_count", 812, null);
    await makeClaim(pageId, blockId, "c1", "812 pages.", "numeric", [evidenceId]);

    const otherPageId = await makePage(await makeWork("thin-content-test-other"), "published", "O", "d");
    const corpus = await loadCorpusPages(pool, otherPageId);
    const page = corpus.find((p) => p.pageId === pageId);
    expect(page?.category).toBe("thin-content-test-cat-4");
    expect(page?.facts.has("page_count:812")).toBe(true);

    const categoryFacts = categoryFactsFor(corpus, "thin-content-test-cat-4");
    expect(categoryFacts.has("page_count:812")).toBe(true);
  });

  it("end-to-end: load → runDeterministicChecks → persist, and the persisted rows reflect the outcome", async () => {
    const workId = await makeWork("thin-content-test-cat-5");
    const pageId = await makePage(workId, "generated", "Good Title", "A reasonably detailed description.");
    const blockId = await makeBlock(
      pageId,
      1,
      "The 2025 edition runs to 812 pages, restructured around speed drills rather than rote formula lists for time-pressured exam takers who need faster recall under pressure.",
    );
    const evidenceId = await makeEvidence(workId, "page_count", 812, null);
    await makeClaim(pageId, blockId, "c1", "The 2025 edition runs to 812 pages.", "numeric", [evidenceId]);

    const draft = await loadPageDraft(pool, pageId);
    const allEvidenceIds = draft.claims.flatMap((c) => c.evidenceIds);
    const evidenceById = await loadEvidenceByIds(pool, allEvidenceIds);
    const freshnessRules = await loadFreshnessRules(pool);
    const corpusPages = await loadCorpusPages(pool, pageId);
    const categoryFacts = categoryFactsFor(corpusPages, "thin-content-test-cat-5");
    const renderedText = draft.blocks.map((b) => b.body).join(" ");

    const result = runDeterministicChecks({
      page: draft,
      evidenceById,
      freshnessRules,
      structure: { h1Count: 1, h2Count: 3, internalLinkCount: 2, faqCount: 3 },
      renderedText,
      corpusPages,
      categoryFacts,
      pageFacts: new Set(["page_count:812"]),
      thinContentLimits: { templatedRatioMax: 0.7, minMetadataOnlyWordCount: 5, minInformationGain: 0.15 },
    });

    expect(result.passed).toBe(true);

    await persistCheckResults(pool, pageId, result);

    const { rows: runs } = await pool.query(
      `SELECT stage, passed FROM verification_runs WHERE page_id = $1 ORDER BY stage`,
      [pageId],
    );
    expect(runs).toHaveLength(6);
    expect(runs.every((r) => r.passed === true)).toBe(true);

    const { rows: audits } = await pool.query(`SELECT * FROM seo_audits WHERE page_id = $1`, [pageId]);
    expect(audits).toHaveLength(1);
    expect(audits[0].thin_content_flag).toBe(false);
    expect(audits[0].h1_count).toBe(1);

    const { rows: pages } = await pool.query(`SELECT status FROM pages WHERE id = $1`, [pageId]);
    expect(pages[0].status).toBe("checks_passed");
  });

  it("end-to-end failure path: a wrong number routes the page to needs_review and flags the block", async () => {
    const workId = await makeWork("thin-content-test-cat-6");
    const pageId = await makePage(workId, "generated", "Title", "Description.");
    const blockId = await makeBlock(pageId, 1, "The 2025 edition runs to 900 pages."); // wrong — evidence says 812
    const evidenceId = await makeEvidence(workId, "page_count", 812, null);
    await makeClaim(pageId, blockId, "c1", "The 2025 edition runs to 900 pages.", "numeric", [evidenceId]);

    const draft = await loadPageDraft(pool, pageId);
    const evidenceById = await loadEvidenceByIds(pool, draft.claims.flatMap((c) => c.evidenceIds));
    const freshnessRules = await loadFreshnessRules(pool);

    const result = runDeterministicChecks({
      page: draft,
      evidenceById,
      freshnessRules,
      structure: { h1Count: 1, h2Count: 3, internalLinkCount: 2, faqCount: 3 },
      renderedText: draft.blocks.map((b) => b.body).join(" "),
      corpusPages: [],
      categoryFacts: new Set(),
      pageFacts: new Set(),
      thinContentLimits: { templatedRatioMax: 0.7, minMetadataOnlyWordCount: 1, minInformationGain: 0.15 },
    });

    expect(result.passed).toBe(false);
    expect(result.blocksToRegenerate).toEqual(new Set([blockId]));

    await persistCheckResults(pool, pageId, result);

    const { rows: pages } = await pool.query(`SELECT status FROM pages WHERE id = $1`, [pageId]);
    expect(pages[0].status).toBe("needs_review");

    const { rows: blocks } = await pool.query(`SELECT regenerated_count FROM page_blocks WHERE id = $1`, [blockId]);
    expect(blocks[0].regenerated_count).toBe(1);

    const { rows: exactMatchRuns } = await pool.query(
      `SELECT passed, failure_reason FROM verification_runs WHERE page_id = $1 AND stage = 'exact_match'`,
      [pageId],
    );
    expect(exactMatchRuns[0].passed).toBe(false);
    expect(exactMatchRuns[0].failure_reason).toContain("numeric_mismatch");
  });
});
