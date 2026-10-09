const { getEpisodeForWork } = require('../database/repositories/episode-repository.cjs');
const repository = require('../database/repositories/scene-narration-repository.cjs');
const { assertEpisodeUnlocked } = require('../database/repositories/review-job-repository.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { withEpisodeOperation } = require('../review/episode-operation-gate.cjs');
const { readSavedEpisodeContent, verifyEpisodeContentHash } = require('./episode-work-context-builder.cjs');
const { parseSceneLayout } = require('./review-context-builder.cjs');
const { applySceneNarration } = require('./scene-narration.cjs');

/** Canon이 없는 작품도 저장 TXT에서 동일 파서의 장면 목록과 미확정 POV를 확인할 수 있게 한다. */
async function getForEpisode(storage, input) {
  const episode = getEpisodeForWork(input?.workId, input?.episodeId);
  const content = await readSavedEpisodeContent(storage, episode);
  verifyEpisodeContentHash(episode, content);
  const characters = repository.getCharacters(episode.workId);
  const snapshot = applySceneNarration(content, parseSceneLayout(content), repository.getForEpisode(episode.id), characters);
  return { workId: episode.workId, episodeId: episode.id, ...snapshot, characters,
    scenes: snapshot.scenes.map(scene => ({ identity: scene.identity, index: scene.index, originalRange: scene.originalRange,
      locationHeading: scene.locationHeading, preview: content.slice(scene.originalRange.start, Math.min(scene.originalRange.end, scene.originalRange.start + 160)), narration: scene.narration })) };
}

/** 오래된 Renderer 범위를 신뢰하지 않고 gate 안에서 저장 TXT를 재분석한 후 실제 장면에만 저장한다. */
async function save(storage, input) {
  if (!input || typeof input.episodeId !== 'string' || Object.keys(input).some(key => !['workId', 'episodeId', 'expectedEpisodeContentHash', 'expectedSceneLayoutVersion', 'expectedSceneIdentity', 'narration'].includes(key))) {
    throw new RepositoryError('SCENE_NARRATION_INVALID', '장면 시점 저장 정보를 확인해 주세요.');
  }
  return withEpisodeOperation(input.episodeId, async token => {
    assertEpisodeUnlocked(input.episodeId);
    let snapshot;
    try { snapshot = await getForEpisode(storage, input); }
    catch (cause) {
      if (cause.code === 'EPISODE_CONTENT_HASH_MISMATCH') throw new RepositoryError('SCENE_CONTEXT_STALE', '원고 파일이 변경되었습니다. 회차를 다시 저장한 뒤 장면 목록을 확인해 주세요.');
      throw cause;
    }
    const scene = snapshot.scenes.find(item => item.identity === input.expectedSceneIdentity);
    if (snapshot.episodeContentHash !== input.expectedEpisodeContentHash || snapshot.layoutVersion !== input.expectedSceneLayoutVersion || !scene) {
      throw new RepositoryError('SCENE_CONTEXT_STALE', '원고 또는 장면 구조가 변경되었습니다. 장면 목록을 다시 불러와 주세요.');
    }
    repository.save({ workId: snapshot.workId, episodeId: snapshot.episodeId, episodeContentHash: snapshot.episodeContentHash,
      sceneLayoutVersion: snapshot.layoutVersion, sceneIdentity: scene.identity, narration: input.narration }, token);
    // 저장 직후 DB snapshot만 다시 읽으며 gate 안에서 불필요하게 TXT를 다시 읽지 않는다.
    const rows = repository.getForEpisode(snapshot.episodeId);
    const saved = rows.find(row => row.episodeContentHash === snapshot.episodeContentHash && row.sceneLayoutVersion === snapshot.layoutVersion && row.sceneIdentity === scene.identity);
    return { sceneIdentity: scene.identity, narration: { mode: saved.narrationMode, source: 'AUTHOR_SET',
      narratorCharacter: snapshot.characters.find(character => character.recordId === saved.narratorCharacterId) ?? null, status: 'VALID' } };
  });
}

module.exports = { getForEpisode, save };
