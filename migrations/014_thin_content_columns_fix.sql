-- [FIX] seo_audits.skeleton_similarity_max / skeleton_similarity_against_page_id
-- (added in schema-v4.1.sql, migration 009) assumed a pairwise
-- "most similar single page" metric, matching duplicate_max_similarity
-- next to it. But plan §4a's actual language — "diff the page's
-- sentence structure against a sample of already-published pages" —
-- describes a pooled comparison against the whole corpus's sentence
-- skeletons at once, which is what src/checks/thinContent.ts actually
-- implements (buildCorpusSkeletonSet + templatedSentenceRatio). There
-- is no single "matched page" in that design, so
-- skeleton_similarity_against_page_id was never going to be populated.
--
-- Renamed to match what's actually computed, and the unpopulatable FK
-- column dropped.

ALTER TABLE seo_audits
  RENAME COLUMN skeleton_similarity_max TO templated_sentence_ratio;

ALTER TABLE seo_audits
  DROP COLUMN skeleton_similarity_against_page_id;
