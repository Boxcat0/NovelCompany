-- NULL은 근거 계약 도입 이전의 행이며 기존 내용과 입력 fingerprint를 변경하지 않는다.
ALTER TABLE review_runs ADD COLUMN findings_contract_version TEXT
  CHECK (findings_contract_version IS NULL OR findings_contract_version = 'REVIEW_FINDINGS_V1');
ALTER TABLE review_findings ADD COLUMN contract_version TEXT
  CHECK (contract_version IS NULL OR contract_version = 'REVIEW_FINDINGS_V1');
ALTER TABLE review_findings ADD COLUMN details_json TEXT;
