/** 기존 격리 회귀 테스트에 V1 원문 근거를 제공하며 실제 검사 규칙을 실행하지 않는다. */
function textResult(context, message = '가상 검증 결과') {
  return { contractVersion: 'REVIEW_FINDINGS_V1', findings: [{ category: 'TEXT', severity: 'INFO', assessment: 'UNDETERMINED',
    anchor: { type: 'TEXT_RANGE', range: { start: 0, end: context.episode.content.length }, sceneIdentity: null, sourceExcerpt: context.episode.content },
    message, evidence: '격리 테스트의 고정 결과입니다.', suggestion: null, relatedCanonRecords: [] }] };
}

/** 과거 계약이 없는 이력 fixture를 SQL로 재현하며 운영 저장 API에 우회 경로를 만들지 않는다. */
function completeLegacyRun(runId, findings = []) {
  const db = require('../../database/database.cjs').getDatabase();
  const now = new Date().toISOString();
  findings.forEach((finding, index) => db.prepare('INSERT INTO review_findings (id, review_run_id, category, message, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(require('node:crypto').randomUUID(), runId, finding.category, finding.message, index, now));
  db.prepare("UPDATE review_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(now, runId);
  return require('../../database/repositories/review-repository.cjs').getById(runId);
}

module.exports = { textResult, completeLegacyRun };
