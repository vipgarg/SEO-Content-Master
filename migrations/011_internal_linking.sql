-- ============================================================
-- A.8 Internal linking
-- ============================================================

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

-- [NEW] "Only link to published pages" was prose-only in v4. An
-- automated linking engine pointing at unpublished pages is a common
-- source of soft 404s, so it's enforced here the same way the rest of
-- this schema enforces its structural rules.
CREATE FUNCTION check_internal_link_target_published() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pages WHERE id = NEW.to_page_id AND status = 'published' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'internal_links.to_page_id % must reference a published page', NEW.to_page_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER internal_links_target_published_check
  BEFORE INSERT OR UPDATE ON internal_links
  FOR EACH ROW EXECUTE FUNCTION check_internal_link_target_published();
