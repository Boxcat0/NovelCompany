const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const pending = new Set();

/** 제출의 비동기 TXT 읽기 동안 같은 Episode의 저장 및 재제출을 막는다. */
async function withEpisodeSubmission(episodeId, operation) {
  if (pending.has(episodeId)) throw new RepositoryError('EPISODE_OPERATION_BUSY', '이 회차의 저장 또는 제출이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  pending.add(episodeId);
  try { return await operation(); }
  finally { pending.delete(episodeId); }
}

/** 동기 파일/DB 저장이 제출 중인 Episode를 수정하지 못하도록 확인한다. */
function assertEpisodeOperationAvailable(episodeId) {
  if (pending.has(episodeId)) throw new RepositoryError('EPISODE_OPERATION_BUSY', '이 회차의 제출이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
}

module.exports = { withEpisodeSubmission, assertEpisodeOperationAvailable };
