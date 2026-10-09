CREATE TABLE canon_record_aliases (
  id TEXT PRIMARY KEY,
  canon_record_id TEXT NOT NULL REFERENCES canon_records(id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL CHECK (length(trim(alias_text)) > 0),
  normalized_alias TEXT NOT NULL CHECK (length(trim(normalized_alias)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_record_id, normalized_alias)
);

CREATE TRIGGER canon_alias_character_insert BEFORE INSERT ON canon_record_aliases
WHEN NOT EXISTS (SELECT 1 FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id
  WHERE r.id = NEW.canon_record_id AND s.key = 'character')
BEGIN SELECT RAISE(ABORT, 'CANON_ALIAS_CHARACTER_REQUIRED'); END;

CREATE TRIGGER canon_alias_character_update BEFORE UPDATE ON canon_record_aliases
WHEN NOT EXISTS (SELECT 1 FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id
  WHERE r.id = NEW.canon_record_id AND s.key = 'character')
BEGIN SELECT RAISE(ABORT, 'CANON_ALIAS_CHARACTER_REQUIRED'); END;

-- 기존 Canon V1/V2는 보존하고 Alias-aware 해시를 별도 이름 해석 버전으로 구분한다.
ALTER TABLE review_runs ADD COLUMN name_resolution_version TEXT
  CHECK (name_resolution_version IS NULL OR name_resolution_version = 'CHARACTER_NAMES_V1');
ALTER TABLE review_jobs ADD COLUMN name_resolution_version TEXT
  CHECK (name_resolution_version IS NULL OR name_resolution_version = 'CHARACTER_NAMES_V1');
