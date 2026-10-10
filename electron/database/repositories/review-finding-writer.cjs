const { randomUUID } = require('node:crypto');
const { assertValidatedResult } = require('../../review/review-findings-contract.cjs');

/** 호출자가 연 transaction 안에서만 검증된 결과의 ID·순서를 발급하고 계약 버전을 저장한다. */
function insertValidatedFindings(database, runId, result, now) {
  const run = database.prepare("SELECT * FROM review_runs WHERE id = ? AND status = 'RUNNING'").get(runId);
  assertValidatedResult(result, run ?? {});
  const insert = database.prepare('INSERT INTO review_findings (id, review_run_id, category, message, sort_order, created_at, contract_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  result.findings.forEach((finding, index) => {
    const { category, message, contractVersion, ...details } = finding;
    insert.run(randomUUID(), runId, category, message, index, now, contractVersion, JSON.stringify(details));
  });
  database.prepare('UPDATE review_runs SET findings_contract_version = ? WHERE id = ?').run(result.contractVersion, runId);
}

module.exports = { insertValidatedFindings };
