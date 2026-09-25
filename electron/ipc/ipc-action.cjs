const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { createErrorResult, createSuccessResult } = require("./ipc-result.cjs");
const { logIpcError } = require("../logging/logger.cjs");

/**
 * Repository 호출을 Result 객체로 감싸고 내부 오류는 Main Process 로그에만 기록한다.
 */
async function executeIpcAction(channel, action) {
  try {
    return createSuccessResult(await action());
  } catch (error) {
    if (error instanceof RepositoryError) {
      logIpcError({
        channel,
        code: error.code,
        message: error.message,
        cause: error.cause,
      });
      return createErrorResult(error.code, error.message);
    }

    logIpcError({
      channel,
      code: "INTERNAL_ERROR",
      message: "요청을 처리하는 중 오류가 발생했습니다.",
      cause: error,
    });
    return createErrorResult(
      "INTERNAL_ERROR",
      "요청을 처리하는 중 오류가 발생했습니다.",
    );
  }
}

module.exports = { executeIpcAction };
