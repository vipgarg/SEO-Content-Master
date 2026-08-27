-- A.0 Enums

CREATE TYPE entity_type       AS ENUM ('work','edition','author','publisher','exam','category');
CREATE TYPE source_type       AS ENUM ('first_party','official_exam_body','publisher','amazon_internal','competitor_internal');
CREATE TYPE page_type         AS ENUM ('book','comparison','category','exam','author','publisher');
CREATE TYPE page_status       AS ENUM ('draft','generated','self_critiqued','checks_passed','entailed','scanned','scored','editorial','published','stale','needs_review','archived');
CREATE TYPE claim_type        AS ENUM ('numeric','date','identifier','entity','categorical','descriptive');
CREATE TYPE verdict           AS ENUM ('entailed','partially','not_entailed','contradicted','error');
CREATE TYPE block_type        AS ENUM ('heading','paragraph','list','table','faq','cta','pros_cons');
CREATE TYPE gap_status        AS ENUM ('open','sourcing','resolved','unsourceable');
CREATE TYPE search_intent     AS ENUM ('informational','commercial','transactional','navigational');
