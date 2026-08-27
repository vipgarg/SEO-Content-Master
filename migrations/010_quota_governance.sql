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
