-- 기존 Job은 이전 정책대로 STUB이며 Run의 기존 Processor 및 입력 해시는 보존한다.
ALTER TABLE review_jobs ADD COLUMN processor_key TEXT NOT NULL DEFAULT 'STUB_V1'
  CHECK (processor_key IN ('STUB_V1', 'RULE_V1'));

-- 제출 시 확정한 선택은 대기·실행·종료 이력 동안 변경하지 않는다.
CREATE TRIGGER review_job_processor_immutable
BEFORE UPDATE OF processor_key ON review_jobs
WHEN NEW.processor_key != OLD.processor_key
BEGIN
  SELECT RAISE(ABORT, 'ReviewJob processor selection is immutable');
END;
