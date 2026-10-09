const { randomUUID } = require('node:crypto');
const { getDatabase } = require('../database.cjs');
const { RepositoryError } = require('./repository-error.cjs');
const { getEpisodeForWork } = require('./episode-repository.cjs');
const { assertEpisodeUnlocked } = require('./review-job-repository.cjs');
const { assertEpisodeOperationAvailable } = require('../../review/episode-operation-gate.cjs');
const { SCENE_LAYOUT_VERSION } = require('../../context/scene-narration.cjs');

/** 저장된 버전별 POV를 내부 DTO로 읽고 현재 원고 적용 여부는 순수 Context 함수에 맡긴다. */
function getForEpisode(episodeId) {
  return getDatabase().prepare('SELECT * FROM scene_narration_metadata WHERE episode_id = ?').all(episodeId).map(row => ({
    episodeContentHash: row.episode_content_hash, sceneLayoutVersion: row.scene_layout_version,
    sceneIdentity: row.scene_identity, narrationMode: row.narration_mode,
    narratorCharacterId: row.narrator_character_id, narratorInvalidated: row.narrator_invalidated === 1,
  }));
}

/** 현재 Work의 Generic character Record identity만 반환하며 Legacy Character는 사용하지 않는다. */
function getCharacters(workId) {
  return getDatabase().prepare("SELECT r.id, r.display_name FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id JOIN canon_spaces cs ON cs.id = r.canon_space_id WHERE cs.work_id = ? AND s.key = 'character' ORDER BY r.display_name, r.id").all(workId)
    .map(row => ({ recordId: row.id, setKey: 'character', displayName: row.display_name }));
}

/** Main이 재분석한 장면 설정을 잠금·버전·Character 범위를 재확인한 transaction에서 upsert한다. */
function save(input, operationToken) {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const episode = getEpisodeForWork(input.workId, input.episodeId);
    assertEpisodeOperationAvailable(episode.id, operationToken);
    assertEpisodeUnlocked(episode.id);
    if (!/^[a-f0-9]{64}$/.test(input.episodeContentHash ?? '') || !/^[a-f0-9]{64}$/.test(input.sceneIdentity ?? '') || input.sceneLayoutVersion !== SCENE_LAYOUT_VERSION || (episode.contentHash !== null && episode.contentHash !== input.episodeContentHash)) {
      throw new RepositoryError('SCENE_CONTEXT_STALE', '원고 또는 장면 구조가 변경되었습니다. 장면 목록을 다시 불러와 주세요.');
    }
    const { mode, narratorCharacterId } = input.narration ?? {};
    if (!['FIRST_PERSON_CHARACTER', 'EXTERNAL_THIRD_PERSON', 'UNKNOWN'].includes(mode) || (mode === 'FIRST_PERSON_CHARACTER' ? typeof narratorCharacterId !== 'string' || !narratorCharacterId : narratorCharacterId !== null)) {
      throw new RepositoryError('SCENE_NARRATION_INVALID', '서술 시점과 서술자 선택을 확인해 주세요.');
    }
    if (narratorCharacterId && !getCharacters(input.workId).some(character => character.recordId === narratorCharacterId)) {
      throw new RepositoryError('SCENE_NARRATOR_INVALID', '이 작품에 등록된 캐릭터만 서술자로 지정할 수 있습니다.');
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO scene_narration_metadata (id, episode_id, episode_content_hash, scene_layout_version, scene_identity, narration_mode, narrator_character_id, narrator_invalidated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(episode_id, episode_content_hash, scene_layout_version, scene_identity) DO UPDATE SET
      narration_mode = excluded.narration_mode, narrator_character_id = excluded.narrator_character_id, narrator_invalidated = 0, updated_at = excluded.updated_at`)
      .run(randomUUID(), episode.id, input.episodeContentHash, input.sceneLayoutVersion, input.sceneIdentity, mode, narratorCharacterId, now, now);
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError('SCENE_NARRATION_SAVE_FAILED', '장면 시점을 저장하지 못했습니다.', cause);
  }
}

module.exports = { getForEpisode, getCharacters, save };
