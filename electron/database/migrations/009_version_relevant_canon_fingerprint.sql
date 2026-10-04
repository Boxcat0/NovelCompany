-- Task025의 과거 RELEVANT_CANON_V1 Run과 속성 참조를 포함한 새 V2 Run을 구분한다.
ALTER TABLE review_runs ADD COLUMN fingerprint_version TEXT NOT NULL DEFAULT 'V1'
  CHECK (fingerprint_version IN ('V1', 'V2'));
