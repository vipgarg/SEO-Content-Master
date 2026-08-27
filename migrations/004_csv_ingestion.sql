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
