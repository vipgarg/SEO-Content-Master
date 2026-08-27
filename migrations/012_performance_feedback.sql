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
