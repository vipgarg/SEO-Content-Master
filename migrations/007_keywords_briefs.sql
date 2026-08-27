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
