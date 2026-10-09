const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const pending = new Map();

/** 제출의 비동기 TXT 읽기 동안 같은 Episode의 저장 및 재제출을 막는다. */
async function withEpisodeSubmission(episodeId, operation) {
  return withEpisodeOperation(episodeId, operation);
}

/** 제출과 장면 설정 저장에 같은 Episode gate를 쓰고 소유 토큰을 Main 내부에만 전달한다. */
async function withEpisodeOperation(episodeId, operation) {
  if (pending.has(episodeId)) throw new RepositoryError('EPISODE_OPERATION_BUSY', '이 회차의 저장 또는 제출이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  const token = {};
  pending.set(episodeId, token);
  try { return await operation(token); }
  finally { pending.delete(episodeId); }
}

/** 동기 파일/DB 저장이 제출 중인 Episode를 수정하지 못하도록 확인한다. */
function assertEpisodeOperationAvailable(episodeId, token) {
  if (pending.has(episodeId) && pending.get(episodeId) !== token) throw new RepositoryError('EPISODE_OPERATION_BUSY', '이 회차의 저장 또는 제출이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
}

module.exports = { withEpisodeSubmission, withEpisodeOperation, assertEpisodeOperationAvailable };
