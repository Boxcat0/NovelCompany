const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { createStubReviewProcessor } = require('./stub-review-processor.cjs');
const { createRuleReviewProcessor } = require('./rule-review-processor.cjs');

/** 운영 제출에서 STUB 기본값 또는 작가가 명시한 RULE만 허용한다. */
function validateProcessorSelection(value) {
  if (value === undefined) return 'STUB_V1';
  if (value !== 'STUB_V1' && value !== 'RULE_V1') throw new RepositoryError('REVIEW_PROCESSOR_INVALID', '지원하는 검토 방식(STUB_V1 또는 RULE_V1)을 선택해 주세요.');
  return value;
}

/** 저장된 선택으로 운영 Processor를 생성하며 Mock·임의 모듈을 로드하지 않는다. */
function createReviewProcessor(key) {
  return validateProcessorSelection(key) === 'RULE_V1' ? createRuleReviewProcessor() : createStubReviewProcessor();
}

module.exports = { validateProcessorSelection, createReviewProcessor };
