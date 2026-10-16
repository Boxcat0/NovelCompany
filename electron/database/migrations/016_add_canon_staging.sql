-- 정식 Canon과 분리한 원본 Import 및 작가 수정 후보를 보관한다.
CREATE UNIQUE INDEX idx_canon_spaces_work_scope ON canon_spaces(id, work_id);
CREATE TABLE canon_staging_imports (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  canon_space_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  format_version TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
  result_json TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(id, canon_space_id, work_id),
  UNIQUE(canon_space_id, source_hash),
  FOREIGN KEY(canon_space_id, work_id) REFERENCES canon_spaces(id, work_id) ON DELETE CASCADE
);
CREATE TABLE canon_staging_records (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  canon_space_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  set_key TEXT NOT NULL,
  draft_key TEXT NOT NULL,
  source_json TEXT NOT NULL,
  current_json TEXT NOT NULL,
  author_edited INTEGER NOT NULL DEFAULT 0 CHECK(author_edited IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(canon_space_id, draft_key),
  FOREIGN KEY(import_id, canon_space_id, work_id) REFERENCES canon_staging_imports(id, canon_space_id, work_id) ON DELETE CASCADE,
  FOREIGN KEY(canon_space_id, work_id) REFERENCES canon_spaces(id, work_id) ON DELETE CASCADE
);
CREATE INDEX idx_canon_staging_scope_set ON canon_staging_records(canon_space_id, set_key, id);
CREATE TABLE canon_staging_promotions (
  staging_record_id TEXT PRIMARY KEY REFERENCES canon_staging_records(id) ON DELETE CASCADE,
  canon_set_id TEXT NOT NULL REFERENCES canon_sets(id) ON DELETE CASCADE,
  record_id TEXT REFERENCES canon_records(id) ON DELETE SET NULL,
  record_uuid TEXT NOT NULL,
  approved_revision INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('CREATE', 'LINK')),
  approved_at TEXT NOT NULL
);
