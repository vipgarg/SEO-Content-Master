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
