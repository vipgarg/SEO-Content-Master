# Gyan Sadhan SEO Content Engine — Schema Specification (v4)

Companion to v2 (architecture) and v3 (generation flow). This document is the source of truth for:

- Part A: PostgreSQL DDL — every table
- Part B: BDIP / BookRadar ownership boundary
- Part C: schema.org markup mapping

Conventions used throughout: `BIGSERIAL` keys, `TIMESTAMPTZ` everywhere, soft delete via `deleted_at`, `job_runs` audit logging consistent with BDIP.

---

# PART A — DATABASE SCHEMA

## A.0 Enums

```sql
CREATE TYPE entity_type       AS ENUM ('work','edition','author','publisher','exam','category');
CREATE TYPE source_type       AS ENUM ('first_party','official_exam_body','publisher','amazon_internal','competitor_internal');
CREATE TYPE page_type         AS ENUM ('book','comparison','category','exam','author','publisher');
CREATE TYPE page_status       AS ENUM ('draft','generated','self_critiqued','checks_passed','entailed','scanned','scored','editorial','published','stale','needs_review','archived');
CREATE TYPE claim_type        AS ENUM ('numeric','date','identifier','entity','categorical','descriptive');
CREATE TYPE verdict           AS ENUM ('entailed','partially','not_entailed','contradicted','error');
CREATE TYPE block_type        AS ENUM ('heading','paragraph','list','table','faq','cta','pros_cons');
CREATE TYPE gap_status        AS ENUM ('open','sourcing','resolved','unsourceable');
CREATE TYPE search_intent     AS ENUM ('informational','commercial','transactional','navigational');
```

---

## A.1 Catalog: works and editions

The work→edition split is what makes edition invalidation possible. v1's flat books table could not express "the 2023 edition is superseded but the book still exists."

```sql
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
```

That partial unique index is deliberate: exactly one current edition per work, enforced by the database rather than by application code.

```sql
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

CREATE TABLE categories (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  parent_id    BIGINT REFERENCES categories(id),
  is_exam      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE work_exams (
  work_id      BIGINT NOT NULL REFERENCES works(id),
  exam_id      BIGINT NOT NULL REFERENCES exams(id),
  relevance    NUMERIC CHECK (relevance BETWEEN 0 AND 1),
  evidence_id  BIGINT REFERENCES evidence(id),   -- must be official_exam_body
  PRIMARY KEY (work_id, exam_id)
);
```

`work_exams.evidence_id` is the enforcement point for "no syllabus claim without an official source." If it's null, the page cannot assert exam relevance.

---

## A.2 CSV ingestion

```sql
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
```

The raw row is retained in `raw` so a matching-logic improvement can be replayed against past imports without re-uploading.

---

## A.3 Evidence

Extended from v2 §5.

```sql
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
```

`amazon_never_publishable` is the important one. Constraint C3 from v2 is now enforced by Postgres, not by application discipline. A bug cannot leak Amazon data onto a page.

```sql
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
```

---

## A.4 Keywords and briefs

```sql
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
```

---

## A.5 Pages, blocks, claims

This is the core of the verification system, and the part v2 left undefined.

```sql
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
```

Two rules worth enforcing in application code, since Postgres can't express them cleanly:

- Every claim of type `numeric`, `date`, `identifier` or `entity` must have at least one row in `claim_evidence`. Only `descriptive` claims may be unsourced.
- `descriptive_ratio` on the page must stay under the brief's `descriptive_ratio_max`.

```sql
CREATE TABLE unsupported_flags (
  id          BIGSERIAL PRIMARY KEY,
  page_id     BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,     -- model's own admission: 'could not source MCQ count'
  gap_id      BIGINT REFERENCES evidence_gaps(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## A.6 Verification runs and audits

```sql
CREATE TABLE verification_runs (
  id             BIGSERIAL PRIMARY KEY,
  page_id        BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,   -- 'structural','exact_match','entailment','banned_claim','rubric'
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
  duplicate_max_similarity NUMERIC,   -- shingling vs published corpus
  duplicate_against_page_id BIGINT REFERENCES pages(id),
  schema_valid    BOOLEAN,
  score           INT CHECK (score BETWEEN 0 AND 100),
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## A.7 Quota governance

Supports v3 §4.

```sql
CREATE TABLE api_quota_ledger (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  quota_date    DATE NOT NULL,      -- Pacific-midnight day boundary
  requests_used INT NOT NULL DEFAULT 0,
  tokens_used   BIGINT NOT NULL DEFAULT 0,
  requests_cap  INT NOT NULL,
  throttled_count INT NOT NULL DEFAULT 0,
  UNIQUE (provider, model, quota_date)
);
```

---

## A.8 Internal linking

```sql
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
```

Only link to pages in `published` status. An automated linking engine pointing at unpublished pages is a common source of soft 404s.

---

## A.9 Performance feedback

```sql
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
```

---

# PART B — OWNERSHIP BOUNDARY

The question "who owns the canonical book record" needs a single answer, or you get drift.

| Concern | Owner | This system's access |
|---|---|---|
| Amazon/competitor scraping, publisher release monitoring | **BookRadar** | None directly |
| Canonical commerce catalog (price, stock, product page) | **Supabase** (gyansadhan.com) | Read-only sync → `editions.our_price`, `in_stock` |
| Demand scoring across all signals | **BDIP** | Read-only via API → `works.bdip_score` |
| Content entities (works, editions, authors, publishers, exams) | **This system** | Owns them |
| Evidence, claims, pages, blocks | **This system** | Owns them |

Rules:

1. **This system never writes to Supabase or BookRadar.** One-way sync only.
2. **This system never scrapes Amazon.** If it needs a competitor signal, it reads BDIP's output. This keeps the ToS-exposed surface in exactly one place.
3. **BDIP score is cached, not queried per request.** Sync nightly into `works.bdip_score`. A BDIP outage must not stall content generation.
4. **`editions` is this system's own record**, seeded from Supabase + BookRadar but not a mirror. It carries content-specific fields (evidence links, supersession) those systems don't have.
5. **Entity resolution runs here**, ISBN-13 first, ISBN-10 second, fuzzy title last with `match_confidence` recorded. Anything below threshold is a rejected CSV row, not a guess.

The practical version: BookRadar knows what exists in the market, Supabase knows what you sell, BDIP knows what's worth advertising, and this system knows what you can truthfully say in public.

---

# PART C — SCHEMA.ORG MARKUP

## C.1 The `aggregateRating` problem

Your rating and review-count data comes from Amazon. It is `publishable = false`. Putting it in structured data is republishing it, and marking up ratings you didn't collect is a documented cause of manual actions for structured-data spam.

**Decision: ship no `aggregateRating` and no `review` markup until Gyan Sadhan has its own reviews.** When you collect first-party reviews, add it then — the schema below has the slot ready but unused.

This costs you review stars in the SERP. It also removes the single most likely reason your rich results get pulled manually. Take the trade.

## C.2 Evidence attribute → schema.org property

Every property below must resolve to a `publishable = true` evidence row or a first-party catalog field. If the evidence is missing, **omit the property** — never emit a placeholder or a guess.

### Book pages — `Book` + `Offer`

| schema.org property | Source | Required |
|---|---|---|
| `@type: Book` | — | yes |
| `name` | `editions` via first-party catalog | yes |
| `isbn` | `editions.isbn13` | yes |
| `author` (`@type: Person`, `name`, `url`) | `authors` | yes |
| `publisher` (`@type: Organization`) | `publishers` | yes |
| `bookEdition` | evidence `edition_label`, source `publisher` | if sourced |
| `numberOfPages` | evidence `page_count`, source `publisher` | if sourced |
| `datePublished` | evidence `published_on`, source `publisher` | if sourced |
| `inLanguage` | `works.language` | yes |
| `bookFormat` | `editions.binding` → `Paperback`/`Hardcover` | if known |
| `image` | own catalog image URL only | yes |
| `description` | page meta description | yes |
| `offers` → `@type: Offer` | | yes |
| `offers.price` | `editions.our_price` (first-party) | yes |
| `offers.priceCurrency` | `INR` | yes |
| `offers.availability` | `editions.in_stock` → `InStock`/`OutOfStock` | yes |
| `offers.url` | canonical page URL | yes |
| `offers.seller` | Gyan Sadhan `Organization` | yes |
| `aggregateRating` | **omitted** — see C.1 | no |

### Comparison pages — `ItemList`

`@type: ItemList` with `itemListElement` of `ListItem` → `Book`. Do not use `Product` with a rating. Do not imply an editorial verdict in markup.

### Category and exam pages — `ItemList` + `FAQPage`

`ItemList` of the recommended books, plus `FAQPage` if the page carries FAQs. Exam pages additionally reference the official body — but only `about`/`mentions`, never claiming affiliation.

### Author and publisher pages

`@type: Person` / `Organization`, with `mainEntityOfPage` and a `hasPart` or `ItemList` of works. `sameAs` only where you have a verified official URL in evidence.

### Every page

`BreadcrumbList` — generated from the URL hierarchy, always safe.

## C.3 FAQPage caution

Google restricted FAQ rich results to authoritative government and health sites in 2023. `FAQPage` markup on a commerce page will almost certainly not render rich results.

Keep the markup — it's valid, harmless, and machine-readable — but do not count on SERP real estate from it, and do not let the content engine pad pages with FAQs on the theory that it wins rich results. FAQs should exist because users ask those questions, and each answer still needs claim-level evidence like any other block.

## C.4 Validation

Add to the deterministic check stage (v3 §5 step 4, free, pre-Gemini):

- JSON-LD parses and validates against the type definition.
- Every property present traces to an evidence id or first-party field; log the mapping in `seo_audits.details`.
- `aggregateRating` and `review` are **absent** — assert this explicitly as a regression guard.
- Price in markup equals price in visible text. A mismatch is a structured-data violation and it's an easy bug to ship.
