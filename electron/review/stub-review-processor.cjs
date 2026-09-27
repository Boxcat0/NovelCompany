/** 저장된 WorkContext만 받아 Stub 검토 계약의 빈 Finding 결과를 반환한다. */
function createStubReviewProcessor() {
  return {
    processorKey: "STUB_V1",
    async review(workContext) {
      if (!workContext || workContext.scope !== "FULL_CANON") throw new Error("WorkContext is required.");
      return { findings: [] };
    },
  };
}

module.exports = { createStubReviewProcessor };
