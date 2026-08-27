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
