-- ============================================================
-- A.5 Pages, blocks, claims
--
-- This is the core of the verification system.
-- ============================================================

CREATE TABLE pages (
  id              BIGSERIAL PRIMARY KEY,
  page_type       page_type NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  cluster_id      BIGINT REFERENCES keyword_clusters(id),
  brief_id        BIGINT REFERENCES content_briefs(id),

  primary_entity_type entity_type NOT NULL,
  primary_entity_id   BIGINT NOT NULL,
  secondary_entity_id BIGINT,          -- comparison pages: the second book

  meta_title      TEXT,
  meta_description TEXT,
  canonical_url   TEXT,
  status          page_status NOT NULL DEFAULT 'draft',

  seo_score       INT CHECK (seo_score BETWEEN 0 AND 100),
  rubric_score    INT CHECK (rubric_score BETWEEN 0 AND 100),
  descriptive_ratio NUMERIC,
  word_count      INT,
  content_hash    TEXT,                -- drives incremental Astro builds

  generator_model TEXT,
  generated_at    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  stale_since     TIMESTAMPTZ,
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ON pages (status) WHERE deleted_at IS NULL;
CREATE INDEX ON pages (primary_entity_type, primary_entity_id);
CREATE UNIQUE INDEX ON pages (primary_entity_type, primary_entity_id, page_type, COALESCE(secondary_entity_id,0))
  WHERE deleted_at IS NULL;

-- [NOTE] `evidence_gap` deliberately has no page_status value. A gap is
-- an entity/attribute-level fact (tracked in evidence_gaps, above) that
-- blocks a page from ever being created in Step 1 — by the time a
-- `pages` row exists, evidence was sufficient. This is more precise
-- than treating it as a page-flow branch.

CREATE TABLE page_blocks (
  id           BIGSERIAL PRIMARY KEY,
  page_id      BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_key    TEXT NOT NULL,          -- 'b1' — matches the LLM JSON output
  position     INT NOT NULL,
  block_type   block_type NOT NULL,
  section      TEXT,                   -- maps to the brief's outline section
  heading      TEXT,
  body         TEXT,
  is_required  BOOLEAN NOT NULL DEFAULT false,  -- false ⇒ strippable on failure
  regenerated_count INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, block_key)
);
CREATE INDEX ON page_blocks (page_id, position);

CREATE TABLE claims (
  id             BIGSERIAL PRIMARY KEY,
  page_id        BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id       BIGINT NOT NULL REFERENCES page_blocks(id) ON DELETE CASCADE,
  claim_key      TEXT NOT NULL,        -- 'c1'
  claim_text     TEXT NOT NULL,
  claim_type     claim_type NOT NULL,

  -- deterministic check (v3 step 4)
  extracted_value_num  NUMERIC,
  extracted_value_date DATE,
  extracted_value_text TEXT,
  exact_match_passed   BOOLEAN,

  -- entailment check (v3 step 5)
  verdict        verdict,
  verdict_confidence NUMERIC,
  verdict_reason TEXT,
  verifier_model TEXT,
  verified_at    TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, claim_key)
);
CREATE INDEX ON claims (page_id, verdict);
CREATE INDEX ON claims (block_id);

CREATE TABLE claim_evidence (
  claim_id     BIGINT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id  BIGINT NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (claim_id, evidence_id)
);

-- Rules worth enforcing in application code, since Postgres can't
-- express them cleanly across a join like this:
--
-- - Every claim of type numeric, date, identifier, entity OR
--   categorical [FIX: categorical added — superlatives are categorical
--   claims, and are exactly what the banned-claim scan cares about]
--   must have at least one row in claim_evidence. Only `descriptive`
--   claims may be unsourced.
-- - `descriptive_ratio` on the page must stay under the brief's
--   `descriptive_ratio_max`.

CREATE TABLE unsupported_flags (
  id          BIGSERIAL PRIMARY KEY,
  page_id     BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,     -- model's own admission: 'could not source MCQ count'
  gap_id      BIGINT REFERENCES evidence_gaps(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
