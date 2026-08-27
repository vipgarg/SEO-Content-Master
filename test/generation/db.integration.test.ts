// Integration test for src/generation/db.ts against real Postgres.

import "dotenv/config";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCallResult } from "../../src/generation/claudeClient.js";
import { loadBrief, loadEvidencePack, persistDraft, runGeneration } from "../../src/generation/db.js";
import type { DraftPage } from "../../src/generation/types.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let idCounter = 3_000_000 + Math.floor(Math.random() * 5_000_000);
function nextId(): number {
  return idCounter++;
}

async function makeWork(): Promise<number> {
  const n = nextId();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO works (canonical_title, slug) VALUES ($1, $2) RETURNING id`,
    [`Test Work ${n}`, `gen-test-work-${n}`],
  );
  return result.rows[0]!.id;
}

async function makeBrief(minEvidence: number): Promise<number> {
  const n = nextId();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO content_briefs (page_type, name, outline, word_budget_min, word_budget_max, min_evidence)
     VALUES ('book', $1, '{}'::jsonb, 100, 500, $2) RETURNING id`,
    [`Test Brief ${n}`, minEvidence],
  );
  return result.rows[0]!.id;
}

async function makePage(workId: number, briefId: number): Promise<number> {
  const n = nextId();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO pages (page_type, slug, primary_entity_type, primary_entity_id, brief_id, status)
     VALUES ('book', $1, 'work', $2, $3, 'draft') RETURNING id`,
    [`gen-test-page-${n}`, workId, briefId],
  );
  return result.rows[0]!.id;
}

async function makeEvidence(
  workId: number,
  attribute: string,
  valueNum: number | null,
  sourceType = "publisher",
  retrievedAt = "now()",
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO evidence (entity_type, entity_id, attribute, value_num, source_type, source_url, retrieved_at, confidence, publishable)
     VALUES ('work', $1, $2, $3, $4, 'https://example.com', ${retrievedAt}, 0.9, true) RETURNING id`,
    [workId, attribute, valueNum, sourceType],
  );
  return result.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM pages WHERE slug LIKE 'gen-test-page-%'");
  await pool.query("DELETE FROM works WHERE slug LIKE 'gen-test-work-%'");
  await pool.query("DELETE FROM content_briefs WHERE name LIKE 'Test Brief %'");
  await pool.query("DELETE FROM evidence_gaps WHERE entity_type = 'work'");
}

describe("generation/db (integration)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("loadEvidencePack returns only publishable, fresh, correctly-sourced rows", async () => {
    const workId = await makeWork();
    const goodId = await makeEvidence(workId, "page_count", 812, "publisher");
    await makeEvidence(workId, "our_price", 499, "first_party", "now() - interval '2 days'"); // stale (24h max)
    const syllabusWrongSource = await makeEvidence(workId, "syllabus_coverage", 1, "first_party"); // wrong source (needs a value to satisfy has_a_value)

    const pack = await loadEvidencePack(pool, "work", workId);
    const ids = pack.map((p) => p.id);
    expect(ids).toContain(goodId);
    expect(ids).not.toContain(syllabusWrongSource);
    // stale row excluded too
    const staleAttr = pack.find((p) => p.attribute === "our_price");
    expect(staleAttr).toBeUndefined();
    // Regression guard: this is the id findUnknownEvidenceReferences
    // puts into a Set and checks with genuine JSON numbers from
    // Claude's real tool-call output. A BIGINT id returned as a string
    // (pg's default) would make every legitimate claim citing it look
    // like a hallucinated reference — see typeParsers.ts.
    expect(typeof pack[0]?.id).toBe("number");
    expect(new Set(ids).has(Number(goodId))).toBe(true);
  });

  it("loadEvidencePack excludes non-publishable evidence (the Amazon-data firewall)", async () => {
    const workId = await makeWork();
    await pool.query(
      `INSERT INTO evidence (entity_type, entity_id, attribute, value_num, source_type, source_url, retrieved_at, confidence, publishable)
       VALUES ('work', $1, 'rating', 4, 'amazon_internal', 'https://amazon.example/product/x', now(), 0.9, false)`,
      [workId],
    );
    const pack = await loadEvidencePack(pool, "work", workId);
    expect(pack.find((p) => p.attribute === "rating")).toBeUndefined();
  });

  it("loadBrief converts numeric/interval columns to the right JS types", async () => {
    const briefId = await makeBrief(6);
    const brief = await loadBrief(pool, briefId);
    expect(brief.minEvidence).toBe(6);
    expect(brief.descriptiveRatioMax).toBe(0.4); // schema default
    expect(brief.faqCountMin).toBe(2); // migration 013 default
    expect(brief.faqCountMax).toBe(8);
  });

  it("persistDraft writes blocks/claims/claim_evidence and advances page status", async () => {
    const workId = await makeWork();
    const briefId = await makeBrief(1);
    const pageId = await makePage(workId, briefId);
    const evidenceId = await makeEvidence(workId, "page_count", 812);

    const draft: DraftPage = {
      meta_title: "Test Title",
      meta_description: "Test description.",
      unsupported_flags: ["could not source MCQ count"],
      blocks: [
        {
          block_key: "b1",
          block_type: "paragraph",
          section: null,
          heading: null,
          body: "812 pages.",
          is_required: true,
          claims: [{ claim_key: "c1", claim_text: "812 pages", claim_type: "numeric", evidence_ids: [evidenceId] }],
        },
      ],
    };

    await persistDraft(pool, pageId, draft, "self_critiqued", "claude-test-model");

    const { rows: pages } = await pool.query(
      `SELECT status, meta_title, generator_model, word_count FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(pages[0].status).toBe("self_critiqued");
    expect(pages[0].meta_title).toBe("Test Title");
    expect(pages[0].generator_model).toBe("claude-test-model");
    expect(pages[0].word_count).toBe(2); // "812 pages."

    const { rows: blocks } = await pool.query(`SELECT block_key, body FROM page_blocks WHERE page_id = $1`, [pageId]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_key).toBe("b1");

    const { rows: claims } = await pool.query(
      `SELECT c.claim_key, ce.evidence_id FROM claims c JOIN claim_evidence ce ON ce.claim_id = c.id WHERE c.page_id = $1`,
      [pageId],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].evidence_id).toBe(evidenceId);

    const { rows: flags } = await pool.query(`SELECT note FROM unsupported_flags WHERE page_id = $1`, [pageId]);
    expect(flags).toHaveLength(1);
    expect(flags[0].note).toBe("could not source MCQ count");
  });

  it("persistDraft replaces prior blocks/claims on a second call rather than accumulating them", async () => {
    const workId = await makeWork();
    const briefId = await makeBrief(1);
    const pageId = await makePage(workId, briefId);
    const evidenceId = await makeEvidence(workId, "page_count", 812);

    const draft1: DraftPage = {
      meta_title: "V1",
      meta_description: "d",
      unsupported_flags: [],
      blocks: [{ block_key: "b1", block_type: "paragraph", section: null, heading: null, body: "v1 body", is_required: true, claims: [] }],
    };
    const draft2: DraftPage = {
      meta_title: "V2",
      meta_description: "d",
      unsupported_flags: [],
      blocks: [
        { block_key: "b1", block_type: "paragraph", section: null, heading: null, body: "v2 body", is_required: true, claims: [{ claim_key: "c1", claim_text: "812", claim_type: "numeric", evidence_ids: [evidenceId] }] },
      ],
    };

    await persistDraft(pool, pageId, draft1, "generated", "model-a");
    await persistDraft(pool, pageId, draft2, "self_critiqued", "model-a");

    const { rows: blocks } = await pool.query(`SELECT body FROM page_blocks WHERE page_id = $1`, [pageId]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe("v2 body");
  });

  it("runGeneration routes to evidence_gap and never calls Claude when below min_evidence", async () => {
    const workId = await makeWork();
    const briefId = await makeBrief(6); // needs 6, has 1
    const pageId = await makePage(workId, briefId);
    await makeEvidence(workId, "page_count", 812);

    let claudeCallCount = 0;
    const result = await runGeneration(pool, pageId, "work", workId, briefId, "style", [], {
      apiKey: "k",
      model: "m",
      claudeCall: (async () => {
        claudeCallCount++;
        throw new Error("should never be called");
      }) as never,
    });

    expect(result.outcome).toBe("evidence_gap");
    expect(claudeCallCount).toBe(0);

    const { rows: page } = await pool.query(`SELECT status FROM pages WHERE id = $1`, [pageId]);
    expect(page[0].status).toBe("draft"); // untouched — generation never ran
  });

  it("runGeneration calls generateDraft and persists when evidence is sufficient", async () => {
    const workId = await makeWork();
    const briefId = await makeBrief(1);
    const pageId = await makePage(workId, briefId);
    const evidenceId = await makeEvidence(workId, "page_count", 812);

    const draft: DraftPage = {
      meta_title: "Generated Title",
      meta_description: "d",
      unsupported_flags: [],
      blocks: [
        { block_key: "b1", block_type: "paragraph", section: null, heading: null, body: "812 pages.", is_required: true, claims: [{ claim_key: "c1", claim_text: "812", claim_type: "numeric", evidence_ids: [evidenceId] }] },
      ],
    };
    const claudeCall = async (): Promise<ClaudeCallResult<unknown>> => ({ data: draft });

    const result = await runGeneration(pool, pageId, "work", workId, briefId, "style", [], {
      apiKey: "k",
      model: "claude-test",
      claudeCall: claudeCall as never,
    });

    expect(result.outcome).toBe("generated");
    const { rows: page } = await pool.query(`SELECT status, meta_title FROM pages WHERE id = $1`, [pageId]);
    expect(page[0].status).toBe("self_critiqued");
    expect(page[0].meta_title).toBe("Generated Title");
  });
});
