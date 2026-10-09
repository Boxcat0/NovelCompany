const { hashText, hashValue } = require('./context-fingerprint.cjs');
const SCENE_LAYOUT_VERSION = 'SCENE_LAYOUT_V1';
const SCENE_METADATA_VERSION = 'SCENE_NARRATION_V1';

/** 파서 버전·원문 범위·표제·장면 본문으로 결정적 identity를 만들며 index만으로 연결하지 않는다. */
function sceneIdentity(scene, content, layoutVersion = SCENE_LAYOUT_VERSION) {
  return hashValue({ layoutVersion, index: scene.index, range: scene.originalRange,
    header: scene.locationHeading, contentHash: hashText(content.slice(scene.originalRange.start, scene.originalRange.end)) });
}

/** 현재 원고·파서·identity가 일치하는 작가 설정만 적용하고 구버전과 삭제된 서술자는 미확정으로 남긴다. */
function applySceneNarration(content, scenes, rows = [], characters = [], layoutVersion = SCENE_LAYOUT_VERSION) {
  const episodeContentHash = hashText(content);
  const identities = new Set(scenes.map(scene => sceneIdentity(scene, content, layoutVersion)));
  const currentRows = rows.filter(row => row.episodeContentHash === episodeContentHash && row.sceneLayoutVersion === layoutVersion && identities.has(row.sceneIdentity));
  const current = new Map(currentRows.map(row => [row.sceneIdentity, row]));
  const decorated = scenes.map(scene => {
    const identity = sceneIdentity(scene, content, layoutVersion);
    const row = current.get(identity);
    const character = row?.narratorCharacterId ? characters.find(item => item.recordId === row.narratorCharacterId) ?? null : null;
    const invalidated = Boolean(row?.narratorInvalidated || (row?.narrationMode === 'FIRST_PERSON_CHARACTER' && !character));
    const narration = { mode: invalidated ? 'UNKNOWN' : row?.narrationMode ?? 'UNKNOWN', source: row ? 'AUTHOR_SET' : 'UNSET',
      narratorCharacter: invalidated ? null : character, status: invalidated ? 'NARRATOR_DELETED' : 'VALID' };
    return { ...scene, identity, narration };
  });
  return { episodeContentHash, layoutVersion, metadataVersion: SCENE_METADATA_VERSION,
    hasStaleMetadata: currentRows.length !== rows.length, scenes: decorated };
}

/** 현재 Scene의 의미 있는 서술 설정만 별도 해시하며 Canon selector hash는 변경하지 않는다. */
function buildSceneMetadataHash(snapshot) {
  return hashValue({ metadataVersion: snapshot.metadataVersion, layoutVersion: snapshot.layoutVersion,
    scenes: snapshot.scenes.map(scene => ({ identity: scene.identity, mode: scene.narration.mode,
      source: scene.narration.source, narratorCharacter: scene.narration.narratorCharacter, status: scene.narration.status })) });
}

module.exports = { SCENE_LAYOUT_VERSION, SCENE_METADATA_VERSION, sceneIdentity, applySceneNarration, buildSceneMetadataHash };
