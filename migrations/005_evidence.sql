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
