const fs = require("node:fs");
const { getLogsDirectory } = require("../storage/storage-paths.cjs");

/**
 * IPC 오류의 최소 개발자 진단 정보를 로컬 로그 파일에 추가한다.
 */
function logIpcError({ channel, code, message, cause }) {
  try {
    const timestamp = new Date().toISOString();
    const causeText = cause?.stack || cause?.message || String(cause || "");
    const entry = [
      `[${timestamp}] ERROR`,
      `channel=${channel}`,
      `code=${code}`,
      `message=${message}`,
      causeText ? `cause=${causeText}` : null,
      "",
    ]
      .filter(Boolean)
      .join("\n");

    fs.mkdirSync(getLogsDirectory(), { recursive: true });
    fs.appendFileSync(
      require("node:path").join(getLogsDirectory(), "novelcompany.log"),
      `${entry}\n`,
      "utf8",
    );
  } catch {
    // 로그 기록 실패는 원래 IPC 오류 결과를 바꾸지 않는다.
  }
}

module.exports = { logIpcError };

