const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { createErrorResult, createSuccessResult } = require("./ipc-result.cjs");
const { logIpcError } = require("../logging/logger.cjs");
const { withDataAccess } = require('../backup/data-operation-gate.cjs');

/**
 * 일반 IPC의 DB/TXT 접근을 배타 백업 gate와 Result 계약으로 보호한다.
 */
async function executeIpcAction(channel, action) {
  try {
    return createSuccessResult(await (channel.startsWith('backup:') ? action() : withDataAccess(action)));
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
