const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { parseSceneLayout } = require('../context/review-context-builder.cjs');
const { SCENE_LAYOUT_VERSION, sceneIdentity } = require('../context/scene-narration.cjs');

const NAME = '.transfer-baseline.json';
const UNIT_TABLES = Object.freeze({
  canon: [['canon_field_values', 'record_id'], ['canon_record_option_values', 'record_id'], ['canon_record_references', 'record_id'], ['canon_record_aliases', 'canon_record_id']],
  episode: [['scene_narration_metadata', 'episode_id']],
});

/** JSON 순서와 수정 시각의 차이를 제외하고 논리적 내용의 SHA-256을 계산한다. */
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** 타임스탬프는 비교 보조 정보로만 남기고 논리적 행을 정렬한다. */
function normalized(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'created_at' && key !== 'updated_at')))
    .sort((left, right) => {
      const a = JSON.stringify(left), b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** 하나의 DB와 TXT 트리에서 V1 논리 단위별 내용 해시와 적용용 행을 수집한다. */
function collect(dbFile, manuscriptRoot) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const units = new Map();
    for (const row of db.prepare('SELECT * FROM works ORDER BY id').all()) {
      const data = { row: { ...row } };
      units.set('work:' + row.id, { type: 'work', id: row.id, title: row.title, updatedAt: row.updated_at, data, hash: hash(normalized([row])) });
    }
    for (const row of db.prepare('SELECT * FROM canon_records ORDER BY id').all()) {
      const children = Object.fromEntries(UNIT_TABLES.canon.map(([table, field]) => [table, db.prepare(`SELECT * FROM ${table} WHERE ${field} = ?`).all(row.id).map(item => ({ ...item }))]));
      const data = { row: { ...row }, children };
      units.set('canon:' + row.id, { type: 'canon', id: row.id, title: row.display_name, updatedAt: row.updated_at, data, hash: hash({ row: normalized([row]), children: Object.fromEntries(Object.entries(children).map(([table, rows]) => [table, normalized(rows)])) }) });
    }
    for (const row of db.prepare('SELECT * FROM episodes ORDER BY id').all()) {
      const file = path.join(manuscriptRoot, ...row.storage_key.split('/'));
      const content = fs.readFileSync(file);
      const contentHash = createHash('sha256').update(content).digest('hex');
      if (row.content_hash !== null && row.content_hash !== contentHash) throw new RepositoryError('UPDATE_TXT_HASH_MISMATCH', `회차 ${row.id}의 DB 해시와 TXT가 일치하지 않아 업데이트를 중단했습니다.`);
      const sourceText = content.toString('utf8');
      const sceneIds = new Set(parseSceneLayout(sourceText).map(scene => sceneIdentity(scene, sourceText)));
      const scenes = db.prepare('SELECT * FROM scene_narration_metadata WHERE episode_id = ?').all(row.id).filter(item => item.episode_content_hash === contentHash && item.scene_layout_version === SCENE_LAYOUT_VERSION && sceneIds.has(item.scene_identity)).map(item => ({ ...item }));
      const data = { row: { ...row }, scenes, file, contentHash };
      units.set('episode:' + row.id, { type: 'episode', id: row.id, title: row.title, updatedAt: row.updated_at, data, hash: hash({ row: normalized([row]), scenes: normalized(scenes), contentHash }) });
    }
    return { units, workIds: [...units.keys()].filter(key => key.startsWith('work:')).sort(), spaces: normalized(db.prepare('SELECT * FROM canon_spaces').all()), definition: Object.fromEntries(['canon_sets', 'canon_fields', 'canon_field_options'].map(table => [table, normalized(db.prepare(`SELECT * FROM ${table}`).all())])) };
  } finally { db.close(); }
}

/** 해시만 담는 공통 기준본을 만들고 현재 작업본의 원본 내용은 포함하지 않는다. */
function makeBaseline(snapshot) { return { version: 1, id: randomUUID(), hashes: Object.fromEntries([...snapshot.units].map(([key, unit]) => [key, unit.hash])) }; }

/** 외부 ZIP과 로컬 파일의 기준본 형식을 제한하여 임의 경로나 거대 JSON을 차단한다. */
function validateBaseline(value) {
  if (!value || value.version !== 1 || !/^[a-f0-9-]{36}$/i.test(value.id) || !value.hashes || typeof value.hashes !== 'object' || Array.isArray(value.hashes) || JSON.stringify(value).length > 2_000_000 || Object.entries(value.hashes).some(([key, digest]) => !/^(work|canon|episode):[^:/\\]+$/.test(key) || !/^[a-f0-9]{64}$/.test(digest))) throw new RepositoryError('UPDATE_BASELINE_INVALID', '공통 기준본 정보가 올바르지 않습니다.');
  return value;
}

/** 로컬 공통 기준본 파일을 링크 없이 읽으며, 없으면 안전하게 null을 돌려준다. */
function readBaseline(root) {
  const file = path.join(root, NAME);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new RepositoryError('UPDATE_BASELINE_INVALID', '공통 기준본 파일 형식을 확인해 주세요.');
  try { return validateBaseline(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error instanceof RepositoryError) throw error; throw new RepositoryError('UPDATE_BASELINE_INVALID', '공통 기준본 파일을 읽을 수 없습니다.'); }
}

/** 기준본을 새 파일로 원자 게시하며 기존 기준본은 덮어쓰지 않는다. */
function publishBaseline(root, baseline) {
  validateBaseline(baseline);
  const file = path.join(root, NAME);
  const descriptor = fs.openSync(file, 'wx');
  try { fs.writeFileSync(descriptor, JSON.stringify(baseline)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

/** 현재 작업본의 항목별 해시를 재검사할 수 있는 안정된 비교 지문을 만든다. */
function snapshotFingerprint(snapshot) {
  return hash({ hashes: Object.fromEntries([...snapshot.units].map(([key, unit]) => [key, unit.hash])), definition: snapshot.definition, spaces: snapshot.spaces });
}

/** 미리보기 이후 Review 이력까지 포함해 운영 DB의 모든 영속 행이 그대로인지 확인한다. */
function databaseFingerprint(dbFile, manuscriptRoot) {
  const digest = createHash('sha256');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      digest.update(name);
      for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY rowid`).all()) digest.update(JSON.stringify(row));
    }
    for (const row of db.prepare('SELECT storage_key FROM episodes ORDER BY storage_key').all()) {
      digest.update(row.storage_key);
      digest.update(createHash('sha256').update(fs.readFileSync(path.join(manuscriptRoot, ...row.storage_key.split('/')))).digest('hex'));
    }
    return digest.digest('hex');
  } finally { db.close(); }
}

module.exports = { NAME, UNIT_TABLES, collect, makeBaseline, validateBaseline, readBaseline, publishBaseline, snapshotFingerprint, databaseFingerprint, normalized, hash };
