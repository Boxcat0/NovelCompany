CREATE TABLE scene_narration_metadata (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  episode_content_hash TEXT NOT NULL,
  scene_layout_version TEXT NOT NULL,
  scene_identity TEXT NOT NULL,
  narration_mode TEXT NOT NULL CHECK (narration_mode IN ('FIRST_PERSON_CHARACTER', 'EXTERNAL_THIRD_PERSON', 'UNKNOWN')),
  narrator_character_id TEXT REFERENCES canon_records(id) ON DELETE RESTRICT,
  narrator_invalidated INTEGER NOT NULL DEFAULT 0 CHECK (narrator_invalidated IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (episode_id, episode_content_hash, scene_layout_version, scene_identity),
  CHECK ((narration_mode = 'FIRST_PERSON_CHARACTER' AND narrator_character_id IS NOT NULL AND narrator_invalidated = 0)
    OR (narration_mode IN ('EXTERNAL_THIRD_PERSON', 'UNKNOWN') AND narrator_character_id IS NULL)),
  CHECK (narrator_invalidated = 0 OR narration_mode = 'UNKNOWN')
);

CREATE TRIGGER scene_narrator_scope_insert BEFORE INSERT ON scene_narration_metadata
WHEN NEW.narrator_character_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id
  JOIN canon_spaces cs ON cs.id = r.canon_space_id JOIN episodes e ON e.work_id = cs.work_id
  WHERE r.id = NEW.narrator_character_id AND e.id = NEW.episode_id AND s.key = 'character'
)
BEGIN SELECT RAISE(ABORT, 'SCENE_NARRATOR_INVALID'); END;

CREATE TRIGGER scene_narrator_scope_update BEFORE UPDATE ON scene_narration_metadata
WHEN NEW.narrator_character_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id
  JOIN canon_spaces cs ON cs.id = r.canon_space_id JOIN episodes e ON e.work_id = cs.work_id
  WHERE r.id = NEW.narrator_character_id AND e.id = NEW.episode_id AND s.key = 'character'
)
BEGIN SELECT RAISE(ABORT, 'SCENE_NARRATOR_INVALID'); END;

-- Canon 삭제 transaction 안에서 참조만 무효화하며 다른 Character로 재연결하지 않는다.
CREATE TRIGGER invalidate_deleted_scene_narrator BEFORE DELETE ON canon_records
BEGIN
  UPDATE scene_narration_metadata SET narration_mode = 'UNKNOWN', narrator_character_id = NULL,
    narrator_invalidated = 1 WHERE narrator_character_id = OLD.id;
END;

-- 회차 소유 Metadata는 회차 삭제와 함께 정리한다. FK 실패 시 이 삭제도 rollback된다.
CREATE TRIGGER delete_episode_scene_narration BEFORE DELETE ON episodes
BEGIN DELETE FROM scene_narration_metadata WHERE episode_id = OLD.id; END;

ALTER TABLE review_jobs ADD COLUMN scene_metadata_hash TEXT;
ALTER TABLE review_jobs ADD COLUMN scene_metadata_version TEXT;
ALTER TABLE review_runs ADD COLUMN scene_metadata_hash TEXT;
ALTER TABLE review_runs ADD COLUMN scene_metadata_version TEXT;
