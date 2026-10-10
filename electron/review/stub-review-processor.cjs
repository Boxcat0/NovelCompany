/** 저장본에서 파생한 ReviewContext를 받아 구조 분석과 별개의 빈 Stub Finding을 반환한다. */
function createStubReviewProcessor() {
  return {
    processorKey: "STUB_V1",
    /** 실제 검토 없이 V1의 빈 결과를 반환하여 분석 경고와 Finding을 분리한다. */
    async review(workContext) {
      if (!workContext || workContext.scope !== "RELEVANT_CANON") throw new Error("ReviewContext is required.");
      return { contractVersion: 'REVIEW_FINDINGS_V1', findings: [] };
    },
  };
}

module.exports = { createStubReviewProcessor };
