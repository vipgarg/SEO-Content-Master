-- ============================================================
-- A.6 Verification runs and audits
-- ============================================================

CREATE TABLE verification_runs (
  id             BIGSERIAL PRIMARY KEY,
  page_id        BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,   -- 'structural','exact_match','entailment','banned_claim','rubric','thin_content'
  model          TEXT,
  provider       TEXT,            -- 'gemini','claude','none'
  claims_checked INT,
  passed         BOOLEAN,
  failure_reason TEXT,
  request_tokens INT,
  response_tokens INT,
  latency_ms     INT,
  http_status    INT,             -- 429s tracked here, distinct from failures
  attempt        INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON verification_runs (page_id, stage, created_at DESC);

CREATE TABLE banned_claim_hits (
  id           BIGSERIAL PRIMARY KEY,
  page_id      BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  rule         TEXT NOT NULL,   -- 'exam_guarantee','medical_advice','unsourced_syllabus',...
  offending_span TEXT NOT NULL,
  block_id     BIGINT REFERENCES page_blocks(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seo_audits (
  id              BIGSERIAL PRIMARY KEY,
  page_id         BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  h1_count        INT,
  h2_count        INT,
  meta_title_len  INT,
  meta_desc_len   INT,
  internal_links  INT,
  faq_count       INT,
  readability     NUMERIC,
  duplicate_max_similarity NUMERIC,   -- shingling vs published corpus (exact/near-dup text)
  duplicate_against_page_id BIGINT REFERENCES pages(id),

  -- [NEW] corpus uniqueness / thinness gate (v3.1 §4a) — distinct from
  -- the exact-duplicate shingling above, which doesn't catch pages that
  -- are each textually unique but structurally interchangeable.
  skeleton_similarity_max NUMERIC,        -- highest sentence-skeleton overlap vs. any published page
  skeleton_similarity_against_page_id BIGINT REFERENCES pages(id),
  metadata_only_word_count INT,           -- word count remaining after stripping evidence-restatement sentences
  information_gain_score  NUMERIC,        -- share of the page's facts not already stated elsewhere in its category
  thin_content_flag       BOOLEAN NOT NULL DEFAULT false,

  schema_valid    BOOLEAN,
  score           INT CHECK (score BETWEEN 0 AND 100),
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
