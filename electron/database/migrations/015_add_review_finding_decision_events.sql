-- 작가 판단은 검토 원본과 분리하고 가장 높은 revision을 현재 상태로 사용한다.
CREATE TABLE review_finding_decision_events (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
  decision_status TEXT NOT NULL CHECK (decision_status IN ('NEEDS_FIX', 'REJECTED', 'DEFERRED', 'RESOLVED')),
  note TEXT NOT NULL CHECK (length(note) <= 4000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE (finding_id, revision)
);

CREATE TRIGGER review_finding_decisions_next_revision
BEFORE INSERT ON review_finding_decision_events
WHEN NEW.revision <> (SELECT COALESCE(MAX(revision), 0) + 1 FROM review_finding_decision_events WHERE finding_id = NEW.finding_id)
BEGIN
  SELECT RAISE(ABORT, 'Author decision revision must be next');
END;

CREATE TRIGGER review_finding_decisions_no_update
BEFORE UPDATE ON review_finding_decision_events
BEGIN
  SELECT RAISE(ABORT, 'Author decision events are immutable');
END;

-- 부모 Finding의 명시적 삭제에 따른 정리만 허용한다.
CREATE TRIGGER review_finding_decisions_no_direct_delete
BEFORE DELETE ON review_finding_decision_events
WHEN EXISTS (SELECT 1 FROM review_findings WHERE id = OLD.finding_id)
BEGIN
  SELECT RAISE(ABORT, 'Author decision events are append-only');
END;
