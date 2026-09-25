/**
 * 성공한 IPC 요청의 Result 객체를 생성한다.
 */
function createSuccessResult(data) {
  return { ok: true, data };
}

/**
 * 실패한 IPC 요청의 Result 객체를 생성하고 원본 오류는 포함하지 않는다.
 */
function createErrorResult(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

module.exports = { createErrorResult, createSuccessResult };

