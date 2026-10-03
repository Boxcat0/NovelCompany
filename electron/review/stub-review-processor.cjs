/** 저장본에서 파생한 ReviewContext를 받아 구조 분석과 별개의 빈 Stub Finding을 반환한다. */
function createStubReviewProcessor() {
  return {
    processorKey: "STUB_V1",
    /** 실제 AI 호출 없이 ReviewContext 계약만 확인한다. */
    async review(workContext) {
      if (!workContext || workContext.scope !== "RELEVANT_CANON") throw new Error("ReviewContext is required.");
      return { findings: [] };
    },
  };
}

module.exports = { createStubReviewProcessor };
