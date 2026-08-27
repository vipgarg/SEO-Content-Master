-- ============================================================
-- A.1 (cont.) work_exams  [FIX: moved after evidence, which it
-- references — this was the second forward-reference break in v4]
-- ============================================================

CREATE TABLE work_exams (
  work_id      BIGINT NOT NULL REFERENCES works(id),
  exam_id      BIGINT NOT NULL REFERENCES exams(id),
  relevance    NUMERIC CHECK (relevance BETWEEN 0 AND 1),
  evidence_id  BIGINT REFERENCES evidence(id),   -- must be official_exam_body
  PRIMARY KEY (work_id, exam_id)
);

-- `work_exams.evidence_id` is the enforcement point for "no syllabus
-- claim without an official source." [FIX] Previously enforced only by
-- a comment; now a real trigger, consistent with how amazon_never_publishable
-- enforces its rule at the database level rather than by convention.
CREATE FUNCTION check_work_exam_evidence_source() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evidence_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM evidence
      WHERE id = NEW.evidence_id
        AND source_type = 'official_exam_body'
        AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'work_exams.evidence_id % must reference an official_exam_body evidence row', NEW.evidence_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_exams_evidence_source_check
  BEFORE INSERT OR UPDATE ON work_exams
  FOR EACH ROW EXECUTE FUNCTION check_work_exam_evidence_source();
