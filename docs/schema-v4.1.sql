-- Gyan Sadhan SEO Content Engine — Schema (v4.1)
--
-- Corrected, dependency-ordered version of the v4 schema spec
-- (docs/seo-content-engine-v4-schema.md, uploaded 2026-08-27).
--
-- This file is a point-in-time snapshot, not kept in sync afterward —
-- migrations/*.sql is the actual source of truth for the live schema.
-- Notably, migrations/013 and 014 change content_briefs and seo_audits
-- beyond what's written below (a FAQ-count range column, and a rename
-- of the skeleton-similarity columns once §4a was actually implemented
-- as a pooled corpus comparison rather than the pairwise one guessed at
-- here). See those files' own comments for why.
--
-- Fixes applied relative to v4, marked inline with [FIX]/[NEW]:
--   1. Reordered table creation so every REFERENCES target exists first.
--      v4 had `works` referencing authors/publishers/categories before
--      those tables existed, and `work_exams` referencing `evidence`
--      before the evidence table existed — both fatal to running this
--      as a migration.
--   2. `categorical` claims now required to carry evidence, alongside
--      numeric/date/identifier/entity — superlatives are categorical
--      claims and are exactly what the banned-claim scan worries about.
--   3. `freshness_window(attribute)` implemented as a real function
--      against evidence_freshness_rules, and evidence-pack queries
--      should also filter on required_source (see comment at bottom).
--   4. `work_exams.evidence_id` source_type now enforced by trigger,
--      not just a comment.
--   5. seo_audits extended with columns for the corpus uniqueness /
--      thinness gate (v3.1 §4a).
--   6. internal_links target-must-be-published enforced by trigger.
--
-- Everything else is unchanged from v4 — this is a reordering + gap-fix
-- pass, not a redesign.

-- ============================================================
-- A.0 Enums
-- ============================================================

CREATE TYPE entity_type       AS ENUM ('work','edition','author','publisher','exam','category');
CREATE TYPE source_type       AS ENUM ('first_party','official_exam_body','publisher','amazon_internal','competitor_internal');
CREATE TYPE page_type         AS ENUM ('book','comparison','category','exam','author','publisher');
CREATE TYPE page_status       AS ENUM ('draft','generated','self_critiqued','checks_passed','entailed','scanned','scored','editorial','published','stale','needs_review','archived');
CREATE TYPE claim_type        AS ENUM ('numeric','date','identifier','entity','categorical','descriptive');
CREATE TYPE verdict           AS ENUM ('entailed','partially','not_entailed','contradicted','error');
CREATE TYPE block_type        AS ENUM ('heading','paragraph','list','table','faq','cta','pros_cons');
CREATE TYPE gap_status        AS ENUM ('open','sourcing','resolved','unsourceable');
CREATE TYPE search_intent     AS ENUM ('informational','commercial','transactional','navigational');

-- ============================================================
-- A.1 Catalog: categories, authors, publishers, exams  [FIX: moved
-- ahead of works/editions so works' FKs resolve]
-- ============================================================

CREATE TABLE categories (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  parent_id    BIGINT REFERENCES categories(id),
  is_exam      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE authors (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  title_count  INT NOT NULL DEFAULT 0,    -- maintained by trigger; gates author pages (≥3)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE publishers (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  website_url  TEXT,                       -- evidence sourcing root
  title_count  INT NOT NULL DEFAULT 0,    -- gates publisher pages (≥10)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE exams (
  id                   BIGSERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,          -- 'SSC CGL'
  slug                 TEXT NOT NULL UNIQUE,
  conducting_body      TEXT,                   -- 'SSC','UPSC','NTA','CBSE'
  official_syllabus_url TEXT NOT NULL,         -- required: no exam claim without it
  syllabus_checked_at  TIMESTAMPTZ,
  next_exam_date       DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- A.1 (cont.) works and editions
--
-- The work→edition split is what makes edition invalidation possible.
-- v1's flat books table could not express "the 2023 edition is
-- superseded but the book still exists."
-- ============================================================

CREATE TABLE works (
  id                BIGSERIAL PRIMARY KEY,
  canonical_title   TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  author_id         BIGINT REFERENCES authors(id),
  publisher_id      BIGINT REFERENCES publishers(id),
  category_id       BIGINT REFERENCES categories(id),
  language          TEXT NOT NULL DEFAULT 'en',
  bdip_score        NUMERIC,              -- cached from BDIP, read-only here
  bdip_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX ON works (category_id) WHERE deleted_at IS NULL;
CREATE INDEX ON works (author_id)   WHERE deleted_at IS NULL;

CREATE TABLE editions (
  id                BIGSERIAL PRIMARY KEY,
  work_id           BIGINT NOT NULL REFERENCES works(id),
  isbn13            TEXT UNIQUE,
  isbn10            TEXT,
  edition_label     TEXT,                 -- '2025 Edition', '7th Revised'
  edition_year      INT,
  binding           TEXT,
  page_count        INT,
  published_on      DATE,

  -- first-party commerce data, synced from Supabase
  supabase_product_id TEXT UNIQUE,
  our_price         NUMERIC(10,2),
  our_mrp           NUMERIC(10,2),
  in_stock          BOOLEAN,
  stock_qty         INT,
  commerce_synced_at TIMESTAMPTZ,

  is_current        BOOLEAN NOT NULL DEFAULT true,
  superseded_by     BIGINT REFERENCES editions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX ON editions (work_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX one_current_edition ON editions (work_id) WHERE is_current AND deleted_at IS NULL;

-- That partial unique index is deliberate: exactly one current edition
-- per work, enforced by the database rather than by application code.

-- ============================================================
-- A.2 CSV ingestion
-- ============================================================

CREATE TABLE csv_imports (
  id             BIGSERIAL PRIMARY KEY,
  filename       TEXT NOT NULL,
  row_count      INT NOT NULL,
  matched_count  INT,
  rejected_count INT,
  imported_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE csv_rows (
  id                BIGSERIAL PRIMARY KEY,
  import_id         BIGINT NOT NULL REFERENCES csv_imports(id),
  row_number        INT NOT NULL,
  raw               JSONB NOT NULL,        -- the row exactly as uploaded
  isbn_raw          TEXT,
  isbn13_normalised TEXT,
  matched_edition_id BIGINT REFERENCES editions(id),
  match_method      TEXT,                  -- 'isbn13','isbn10','fuzzy_title','none'
  match_confidence  NUMERIC,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON csv_rows (import_id, matched_edition_id);

-- The raw row is retained in `raw` so a matching-logic improvement can
-- be replayed against past imports without re-uploading.

-- ============================================================
-- A.3 Evidence
-- ============================================================

CREATE TABLE evidence (
  id              BIGSERIAL PRIMARY KEY,
  entity_type     entity_type NOT NULL,
  entity_id       BIGINT NOT NULL,
  attribute       TEXT NOT NULL,
  value_text      TEXT,
  value_num       NUMERIC,
  value_date      DATE,
  value_bool      BOOLEAN,
  unit            TEXT,
  source_type     source_type NOT NULL,
  source_url      TEXT,
  source_quote    TEXT,                  -- internal only, never rendered
  retrieved_at    TIMESTAMPTZ NOT NULL,
  confidence      NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  publishable     BOOLEAN NOT NULL,
  superseded_by   BIGINT REFERENCES evidence(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,

  -- [NOTE] `amazon_internal` here is a provenance tag, not a license to
  -- scrape: per v2/v4 Part B, this system never scrapes Amazon directly.
  -- Rows with source_type = 'amazon_internal' must originate from BDIP's
  -- output, ingested through the same one-way sync as bdip_score.
  CONSTRAINT amazon_never_publishable
    CHECK (source_type NOT IN ('amazon_internal','competitor_internal') OR publishable = false),
  CONSTRAINT has_a_value
    CHECK (num_nonnulls(value_text, value_num, value_date, value_bool) >= 1),
  CONSTRAINT sourced_externally
    CHECK (source_type = 'first_party' OR source_url IS NOT NULL)
);

CREATE INDEX ON evidence (entity_type, entity_id, attribute)
  WHERE deleted_at IS NULL AND superseded_by IS NULL;
CREATE INDEX ON evidence (publishable, retrieved_at)
  WHERE deleted_at IS NULL;

-- `amazon_never_publishable` is the important one. Constraint C3 from v2
-- is now enforced by Postgres, not by application discipline. A bug
-- cannot leak Amazon data onto a page.

CREATE TABLE evidence_freshness_rules (
  attribute       TEXT PRIMARY KEY,
  max_age         INTERVAL NOT NULL,
  required_source source_type
);

INSERT INTO evidence_freshness_rules VALUES
  ('our_price',           INTERVAL '24 hours',  'first_party'),
  ('in_stock',            INTERVAL '1 hour',    'first_party'),
  ('edition_year',        INTERVAL '30 days',   'publisher'),
  ('page_count',          INTERVAL '365 days',  'publisher'),
  ('syllabus_coverage',   INTERVAL '90 days',   'official_exam_body'),
  ('exam_date',           INTERVAL '30 days',   'official_exam_body');

-- [NEW] freshness_window() was referenced by the v3.1 evidence-pack
-- query (SELECT ... WHERE retrieved_at > now() - freshness_window(attribute))
-- but never defined. Implemented here against the table above, with a
-- conservative fallback for any attribute that has no explicit rule.
CREATE FUNCTION freshness_window(p_attribute TEXT) RETURNS INTERVAL AS $$
  SELECT COALESCE(
    (SELECT max_age FROM evidence_freshness_rules WHERE attribute = p_attribute),
    INTERVAL '90 days'   -- conservative default; tighten per-attribute as rules are added
  );
$$ LANGUAGE sql STABLE;

-- [NOTE] The v3.1 evidence-pack query filters on freshness but not on
-- evidence_freshness_rules.required_source. Callers assembling the
-- evidence pack for an attribute that has a required_source set (e.g.
-- syllabus_coverage → official_exam_body) must additionally filter
-- `AND (required_source IS NULL OR evidence.source_type = required_source)`,
-- otherwise a stale-but-technically-fresh first_party row can satisfy a
-- rule meant to require an official source.

CREATE TABLE evidence_gaps (
  id            BIGSERIAL PRIMARY KEY,
  entity_type   entity_type NOT NULL,
  entity_id     BIGINT NOT NULL,
  attribute     TEXT NOT NULL,
  reason        TEXT,                    -- 'missing','stale','low_confidence'
  blocking      BOOLEAN NOT NULL DEFAULT true,
  status        gap_status NOT NULL DEFAULT 'open',
  suggested_url TEXT,
  resolved_evidence_id BIGINT REFERENCES evidence(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  UNIQUE (entity_type, entity_id, attribute)
);

-- ============================================================
-- A.1 (cont.) work_exams  [FIX: moved after evidence, which it
-- references — this was the second forward-reference break in v4]
-- ============================================================

CREATE TABLE work_exams (
  work_id      BIGINT NOT NULL REFERENCES works(id),
  exam_id      BIGINT NOT NULL REFERENCES exams(id),
  relevance    NUMERIC CHECK (relevance BETWEEN 0 AND 1),
  evidence_id  BIGINT REFERENCES evidence(id),   -- must be official_exam_body
  PRIMARY KEY (work_id, exam_id)
);

-- `work_exams.evidence_id` is the enforcement point for "no syllabus
-- claim without an official source." [FIX] Previously enforced only by
-- a comment; now a real trigger, consistent with how amazon_never_publishable
-- enforces its rule at the database level rather than by convention.
CREATE FUNCTION check_work_exam_evidence_source() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evidence_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM evidence
      WHERE id = NEW.evidence_id
        AND source_type = 'official_exam_body'
        AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'work_exams.evidence_id % must reference an official_exam_body evidence row', NEW.evidence_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_exams_evidence_source_check
  BEFORE INSERT OR UPDATE ON work_exams
  FOR EACH ROW EXECUTE FUNCTION check_work_exam_evidence_source();

-- ============================================================
-- A.4 Keywords and briefs
-- ============================================================

CREATE TABLE keyword_clusters (
  id             BIGSERIAL PRIMARY KEY,
  primary_keyword TEXT NOT NULL,
  intent         search_intent NOT NULL,
  entity_type    entity_type,
  entity_id      BIGINT,
  target_page_type page_type,
  priority       INT NOT NULL DEFAULT 50,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (primary_keyword)
);

CREATE TABLE keywords (
  id           BIGSERIAL PRIMARY KEY,
  cluster_id   BIGINT NOT NULL REFERENCES keyword_clusters(id),
  keyword      TEXT NOT NULL,
  variant_type TEXT,        -- 'exact','long_tail','comparison','review','edition','exam'
  volume       INT,         -- nullable; v3 ships without volume data
  difficulty   NUMERIC,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, keyword)
);

CREATE TABLE content_briefs (
  id              BIGSERIAL PRIMARY KEY,
  page_type       page_type NOT NULL,
  name            TEXT NOT NULL,
  outline         JSONB NOT NULL,   -- ordered sections, required/optional, word budgets
  word_budget_min INT NOT NULL,
  word_budget_max INT NOT NULL,
  min_evidence    INT NOT NULL DEFAULT 6,
  descriptive_ratio_max NUMERIC NOT NULL DEFAULT 0.40,
  version         INT NOT NULL DEFAULT 1,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ============================================================
-- A.7 Quota governance
-- ============================================================

CREATE TABLE api_quota_ledger (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  quota_date    DATE NOT NULL,      -- Pacific-midnight day boundary; compute via
                                     -- an America/Los_Angeles-aware date fn, not a
                                     -- fixed UTC offset (DST shifts it twice a year)
  requests_used INT NOT NULL DEFAULT 0,
  tokens_used   BIGINT NOT NULL DEFAULT 0,
  requests_cap  INT NOT NULL,
  throttled_count INT NOT NULL DEFAULT 0,
  UNIQUE (provider, model, quota_date)
);

-- ============================================================
-- A.8 Internal linking
-- ============================================================

CREATE TABLE internal_links (
  id            BIGSERIAL PRIMARY KEY,
  from_page_id  BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id    BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  anchor_text   TEXT NOT NULL,
  relation      TEXT NOT NULL,   -- 'same_author','same_publisher','same_category','alternative','exam'
  position      INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_page_id, to_page_id, relation),
  CHECK (from_page_id <> to_page_id)
);
CREATE INDEX ON internal_links (to_page_id);   -- inbound link counts

-- [NEW] "Only link to published pages" was prose-only in v4. An
-- automated linking engine pointing at unpublished pages is a common
-- source of soft 404s, so it's enforced here the same way the rest of
-- this schema enforces its structural rules.
CREATE FUNCTION check_internal_link_target_published() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages WHERE id = NEW.to_page_id AND status = 'published' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'internal_links.to_page_id % must reference a published page', NEW.to_page_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER internal_links_target_published_check
  BEFORE INSERT OR UPDATE ON internal_links
  FOR EACH ROW EXECUTE FUNCTION check_internal_link_target_published();

-- ============================================================
-- A.9 Performance feedback
-- ============================================================

CREATE TABLE gsc_daily (
  page_id      BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  impressions  INT NOT NULL DEFAULT 0,
  clicks       INT NOT NULL DEFAULT 0,
  ctr          NUMERIC,
  position     NUMERIC,
  PRIMARY KEY (page_id, date)
);

CREATE TABLE page_actions (
  id          BIGSERIAL PRIMARY KEY,
  page_id     BIGINT NOT NULL REFERENCES pages(id),
  action      TEXT NOT NULL,   -- 'rewrite_meta','refresh_content','consolidate','prune'
  reason      TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ
);
