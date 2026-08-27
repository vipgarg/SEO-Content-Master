-- [NEW] plan §5 Step 4 requires "FAQ count within range" as a
-- deterministic check, but content_briefs (schema §A.4) had no column
-- to hold that range — it only had word_budget_min/max, min_evidence,
-- and descriptive_ratio_max. Adding it the same way those were added:
-- per-brief, since the right FAQ count differs by page_type (a book
-- page and a category page don't want the same range).

ALTER TABLE content_briefs
  ADD COLUMN faq_count_min INT NOT NULL DEFAULT 2,
  ADD COLUMN faq_count_max INT NOT NULL DEFAULT 8,
  ADD CONSTRAINT faq_count_range_valid CHECK (faq_count_min <= faq_count_max);
