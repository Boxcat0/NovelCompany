const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase } = require('../database/database.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { writeZip } = require('./backup-zip.cjs');
const baselineStore = require('./transfer-baseline.cjs');
const backup = require('./data-backup-service.cjs');
const { normalizeName } = require('../context/character-name-normalization.cjs');

/** 업데이트 전제 위반을 사용자에게 구분되는 한국어 코드와 메시지로 알린다. */
function fail(code, message) { throw new RepositoryError(code, message); }

/** 동일한 Work·CanonSpace 정체성과 실제 Canon Definition을 검사한다. */
function assertCompatible(current, incoming, currentVersion, incomingVersion) {
  if (currentVersion !== incomingVersion) fail('UPDATE_SCHEMA_MISMATCH', '두 DB의 SQLite Schema 버전이 달라 변경사항 업데이트를 할 수 없습니다. 전체 덮어쓰기를 검토해 주세요.');
  if (JSON.stringify(current.workIds) !== JSON.stringify(incoming.workIds) || JSON.stringify(current.spaces.map(row => [row.id, row.work_id])) !== JSON.stringify(incoming.spaces.map(row => [row.id, row.work_id]))) fail('UPDATE_IDENTITY_MISMATCH', 'Work 또는 CanonSpace ID가 다릅니다. 같은 이름만으로 자동 병합할 수 없습니다.');
  if (JSON.stringify(current.spaces) !== JSON.stringify(incoming.spaces) || JSON.stringify(current.definition) !== JSON.stringify(incoming.definition)) fail('UPDATE_DEFINITION_MISMATCH', '두 DB의 실제 Canon Definition·Field·Option·참조 대상이 다릅니다.');
}

/** 경로를 노출하지 않고 충돌한 Canon 값 또는 TXT 앞부분을 제한된 길이로 요약한다. */
function describeUnit(unit) {
  if (!unit) return null;
  if (unit.type === 'episode' && unit.data?.file) return `TXT ${unit.data.contentHash}: ${fs.readFileSync(unit.data.file, 'utf8').slice(0, 240)}`;
  if (unit.type === 'canon' && unit.data) return JSON.stringify({ name: unit.title, values: unit.data.children }).slice(0, 500);
  return unit.title;
}

/** 공통 조상의 항목별 해시로 한쪽 변경·양쪽 변경·삭제·신규 생성을 구분한다. */
function compare(current, incoming, localBaseline, remoteBaseline) {
  const common = localBaseline && remoteBaseline && localBaseline.id === remoteBaseline.id && JSON.stringify(localBaseline.hashes) === JSON.stringify(remoteBaseline.hashes) ? localBaseline : null;
  const apply = [], conflicts = [], unchanged = [];
  const keys = new Set([...current.units.keys(), ...incoming.units.keys(), ...Object.keys(common?.hashes ?? {})]);
  for (const key of [...keys].sort()) {
    const local = current.units.get(key), remote = incoming.units.get(key), base = common?.hashes[key];
    const label = remote?.title ?? local?.title ?? key;
    const item = { key, type: remote?.type ?? local?.type ?? key.split(':')[0], title: label, currentHash: local?.hash ?? null, incomingHash: remote?.hash ?? null, currentUpdatedAt: local?.updatedAt ?? null, incomingUpdatedAt: remote?.updatedAt ?? null, currentValue: describeUnit(local), incomingValue: describeUnit(remote) };
    if (local?.data?.row && remote?.data?.row && (local.type === 'canon' && (local.data.row.canon_space_id !== remote.data.row.canon_space_id || local.data.row.canon_set_id !== remote.data.row.canon_set_id) || local.type === 'episode' && local.data.row.work_id !== remote.data.row.work_id)) {
      conflicts.push({ ...item, reason: '동일 ID의 Canon 분류 또는 Episode 소속 Work가 다릅니다.' });
      continue;
    }
    if (local?.hash === remote?.hash) { unchanged.push(item); continue; }
    if (!common) { conflicts.push({ ...item, reason: '공통 기준본이 없어 변경 방향을 판단할 수 없습니다.' }); continue; }
    if ((local?.hash ?? null) === (base ?? null)) {
      if (remote && !local && [...current.units.values()].some(unit => unit.type === remote.type && unit.title === remote.title && unit.id !== remote.id)) conflicts.push({ ...item, reason: '같은 이름의 다른 ID가 있어 자동 생성할 수 없습니다.' });
      else apply.push({ ...item, action: remote ? 'incoming' : 'delete' });
    } else if ((remote?.hash ?? null) === (base ?? null)) unchanged.push(item);
    else conflicts.push({ ...item, reason: base ? '양쪽에서 같은 항목을 각각 수정했거나 삭제와 수정이 충돌했습니다.' : '양쪽에서 같은 ID를 독립적으로 생성했습니다.' });
  }
  return { commonBaseline: Boolean(common), apply, conflicts, unchangedCount: unchanged.length };
}

/** 삭제 예정 Record를 병합 결과에 남는 Canon/Scene이 참조하면 다른 충돌과 함께 미리 표시한다. */
function detectReferenceConflicts(plan, current, incoming) {
  for (const item of [...plan.apply].filter(item => item.type === 'canon' && item.action === 'delete')) {
    const targetId = item.key.slice(6);
    const retained = [...new Set([...current.units.keys(), ...incoming.units.keys()])].map(key => plan.apply.some(change => change.key === key) ? incoming.units.get(key) : current.units.get(key)).filter(Boolean);
    const incomingReference = retained.some(unit => unit.type === 'canon' && unit.data.children.canon_record_references.some(ref => ref.target_record_id === targetId) || unit.type === 'episode' && unit.data.scenes.some(scene => scene.narrator_character_id === targetId));
    if (incomingReference) {
      plan.apply.splice(plan.apply.findIndex(change => change.key === item.key), 1);
      plan.conflicts.push({ key: item.key, type: 'canon', title: item.title, reason: '삭제할 Record를 병합 결과의 Canon 또는 Scene Narration이 참조합니다.', currentHash: item.currentHash, incomingHash: item.incomingHash });
    }
  }
}

/** SQLite 행을 정식 컬럼 목록으로 삽입하여 기존 제약·트리거를 그대로 통과시킨다. */
function insertRow(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => row[key]));
}

/** Work의 기본 메타데이터만 갱신하고 로컬 Review·Job 이력은 보존한다. */
function applyWork(db, unit) {
  const row = unit.data.row;
  db.prepare('UPDATE works SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?').run(row.title, row.description, row.status, row.updated_at, row.id);
}

/** Record 부모를 먼저 준비하여 새 Record 사이의 참조 순서를 안전하게 만든다. */
function prepareCanonParents(db, changes, incoming) {
  for (const item of changes.filter(item => item.type === 'canon' && item.action === 'incoming')) {
    const row = incoming.units.get(item.key).data.row;
    if (db.prepare('SELECT 1 FROM canon_records WHERE id = ?').get(row.id)) db.prepare('UPDATE canon_records SET display_name = ?, updated_at = ? WHERE id = ?').run(row.display_name, row.updated_at, row.id);
    else insertRow(db, 'canon_records', row);
  }
}

/** Canon 값을 참조 전·후 순서로 교체하고 FK/트리거가 거부하는 삭제는 적용하지 않는다. */
function applyCanonChildren(db, changes, incoming) {
  const childTables = baselineStore.UNIT_TABLES.canon;
  for (const item of changes.filter(item => item.type === 'canon')) {
    for (const [table, field] of childTables) db.prepare(`DELETE FROM ${table} WHERE ${field} = ?`).run(item.key.slice(6));
  }
  for (const item of changes.filter(item => item.type === 'canon' && item.action === 'incoming')) {
    const children = incoming.units.get(item.key).data.children;
    for (const [table] of childTables.filter(([table]) => table !== 'canon_record_references')) for (const row of children[table]) insertRow(db, table, row);
  }
  for (const item of changes.filter(item => item.type === 'canon' && item.action === 'incoming')) {
    for (const row of incoming.units.get(item.key).data.children.canon_record_references) insertRow(db, 'canon_record_references', row);
  }
  for (const item of changes.filter(item => item.type === 'canon' && item.action === 'delete')) db.prepare('DELETE FROM canon_records WHERE id = ?').run(item.key.slice(6));
}

/** Episode 메타데이터·TXT·현재 원고에 속한 Scene Narration을 하나의 단위로 교체한다. */
function applyEpisodes(db, changes, current, incoming, manuscriptRoot) {
  for (const item of changes.filter(item => item.type === 'episode')) {
    const old = current.units.get(item.key), next = incoming.units.get(item.key);
    if (old) db.prepare('DELETE FROM scene_narration_metadata WHERE episode_id = ?').run(old.id);
    if (item.action === 'delete') db.prepare('DELETE FROM episodes WHERE id = ?').run(old.id);
    else {
      const row = next.data.row;
      if (old) db.prepare('UPDATE episodes SET work_id = ?, episode_number = ?, title = ?, status = ?, storage_key = ?, content_hash = ?, updated_at = ? WHERE id = ?').run(row.work_id, row.episode_number, row.title, row.status, row.storage_key, row.content_hash, row.updated_at, row.id);
      else insertRow(db, 'episodes', row);
      for (const scene of next.data.scenes.filter(scene => scene.episode_content_hash === next.data.contentHash)) insertRow(db, 'scene_narration_metadata', scene);
      const target = path.join(manuscriptRoot, ...row.storage_key.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(next.data.file, target);
    }
    if (old && (item.action === 'delete' || old.data.row.storage_key !== next.data.row.storage_key)) fs.unlinkSync(path.join(manuscriptRoot, ...old.data.row.storage_key.split('/')));
  }
}

/** 병합한 Canon의 필수 Field와 중요 의미 제약을 별도 검증한다. */
function assertCanonSemantics(db, changes) {
  for (const item of changes.filter(item => item.type === 'canon' && item.action === 'incoming')) {
    const id = item.key.slice(6);
    const record = db.prepare('SELECT r.display_name, s.key AS set_key FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id WHERE r.id = ?').get(id);
    if (!record?.display_name.trim()) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 이름이 비어 있습니다.`);
    const fields = db.prepare('SELECT f.id, f.key, f.value_type, f.required FROM canon_fields f JOIN canon_records r ON r.canon_set_id = f.canon_set_id WHERE r.id = ?').all(id);
    const scalar = db.prepare('SELECT * FROM canon_field_values WHERE record_id = ?').all(id);
    const options = db.prepare('SELECT * FROM canon_record_option_values WHERE record_id = ?').all(id);
    const refs = db.prepare('SELECT * FROM canon_record_references WHERE record_id = ?').all(id);
    for (const field of fields) {
      const values = scalar.filter(row => row.field_id === field.id), selected = options.filter(row => row.field_id === field.id), targets = refs.filter(row => row.field_id === field.id);
      if (field.required && !values.length && !selected.length && !targets.length) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 필수 Field ${field.key}가 없습니다.`);
      if (values.length && (!['TEXT', 'LONG_TEXT', 'NUMBER', 'BOOLEAN'].includes(field.value_type) || selected.length || targets.length)) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 Field ${field.key} 값 형식이 맞지 않습니다.`);
      if (selected.length && (!field.value_type.startsWith('OPTION_') || targets.length || selected.length > 1 && field.value_type === 'OPTION_ONE')) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 Option ${field.key}가 올바르지 않습니다.`);
      if (targets.length && (!field.value_type.startsWith('REFERENCE_') || targets.length > 1 && field.value_type === 'REFERENCE_ONE')) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 Reference ${field.key}가 올바르지 않습니다.`);
      for (const value of values) {
        const valid = ['TEXT', 'LONG_TEXT'].includes(field.value_type) ? typeof value.text_value === 'string' && (!field.required || value.text_value.trim().length > 0)
          : field.value_type === 'NUMBER' ? typeof value.number_value === 'number' && Number.isFinite(value.number_value)
            : field.value_type === 'BOOLEAN' && [0, 1].includes(value.boolean_value);
        if (!valid) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 Field ${field.key} 값 형식이 맞지 않습니다.`);
      }
    }
    const knownFieldIds = new Set(fields.map(field => field.id));
    if ([...scalar, ...options, ...refs].some(row => !knownFieldIds.has(row.field_id))) fail('UPDATE_CANON_INVALID', `Canon ${item.title}에 정의 밖 Field가 있습니다.`);
    for (const alias of db.prepare('SELECT alias_text, normalized_alias FROM canon_record_aliases WHERE canon_record_id = ?').all(id)) {
      if (record.set_key !== 'character' || !alias.alias_text.trim() || alias.alias_text.trim().length > 200 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(alias.alias_text) || normalizeName(alias.alias_text) !== alias.normalized_alias || alias.normalized_alias === normalizeName(record.display_name)) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 별칭이 올바르지 않습니다.`);
    }
    const set = db.prepare('SELECT s.key FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id WHERE r.id = ?').get(id);
    const references = new Map(db.prepare('SELECT f.key, ref.target_record_id FROM canon_record_references ref JOIN canon_fields f ON f.id = ref.field_id WHERE ref.record_id = ?').all(id).map(row => [row.key, row.target_record_id]));
    if (set?.key === 'character' && ['origin_location', 'attributes', 'passives'].some(key => !references.has(key))) fail('UPDATE_CANON_INVALID', `Character ${item.title}의 필수 관계가 없습니다.`);
    const pair = set?.key === 'contract' ? ['grantor_character', 'grantee_character'] : set?.key === 'relationship' ? ['source_character', 'target_character'] : null;
    if (pair && references.get(pair[0]) === references.get(pair[1])) fail('UPDATE_CANON_INVALID', `Canon ${item.title}의 자기 참조 관계는 허용되지 않습니다.`);
  }
  const duplicate = db.prepare(`SELECT ref.target_record_id FROM canon_record_references ref JOIN canon_fields f ON f.id = ref.field_id AND f.key = 'passives' JOIN canon_record_option_values ov ON ov.record_id = ref.target_record_id JOIN canon_field_options opt ON opt.id = ov.option_id AND opt.value = 'UNIQUE' GROUP BY ref.target_record_id HAVING COUNT(DISTINCT ref.record_id) > 1 LIMIT 1`).get();
  if (duplicate) fail('UPDATE_CANON_INVALID', '고유 Passive를 여러 Character가 참조합니다.');
  const wrongOrigin = db.prepare(`SELECT character.id FROM canon_records character JOIN canon_sets cs ON cs.id = character.canon_set_id AND cs.key = 'character' JOIN canon_record_references origin ON origin.record_id = character.id JOIN canon_fields ofield ON ofield.id = origin.field_id AND ofield.key = 'origin_location' JOIN canon_record_references world ON world.record_id = character.id JOIN canon_fields wfield ON wfield.id = world.field_id AND wfield.key = 'origin_world' LEFT JOIN canon_record_references locationWorld ON locationWorld.record_id = origin.target_record_id JOIN canon_fields lwfield ON lwfield.id = locationWorld.field_id AND lwfield.key = 'world' WHERE locationWorld.target_record_id <> world.target_record_id LIMIT 1`).get();
  if (wrongOrigin) fail('UPDATE_CANON_INVALID', 'Character 출신 지역과 세계의 관계가 일치하지 않습니다.');
}

/** 임시 DB/TXT만 수정하고 재수집 해시·SQLite FK·공식 백업 검증을 모두 통과한 병합 ZIP을 만든다. */
function buildMergedZip(root, incomingDirectory, current, incoming, plan, destination, applicationVersion, baseline) {
  const stage = path.join(destination, 'merged');
  const databaseFile = path.join(stage, 'database', 'novelcompany.db'), manuscriptRoot = path.join(stage, 'manuscripts');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true }); fs.mkdirSync(manuscriptRoot, { recursive: true });
  getDatabase().exec("VACUUM INTO '" + databaseFile.replace(/'/g, "''") + "'");
  for (const unit of current.units.values()) if (unit.type === 'episode') {
    const target = path.join(manuscriptRoot, ...unit.data.row.storage_key.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(unit.data.file, target);
  }
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec('PRAGMA foreign_keys = ON'); db.exec('BEGIN IMMEDIATE');
    for (const item of plan.apply.filter(item => item.type === 'work')) applyWork(db, incoming.units.get(item.key));
    prepareCanonParents(db, plan.apply, incoming);
    applyCanonChildren(db, plan.apply, incoming);
    applyEpisodes(db, plan.apply, current, incoming, manuscriptRoot);
    assertCanonSemantics(db, plan.apply);
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('UPDATE_REFERENCE_CONFLICT', 'Canon 또는 Episode 참조 충돌로 자동 병합할 수 없습니다.');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 트랜잭션이 이미 종료되었을 수 있다. */ }
    if (error instanceof RepositoryError) throw error;
    fail('UPDATE_REFERENCE_CONFLICT', `Canon·Episode 참조나 제약조건 충돌로 병합할 수 없습니다: ${error.message}`);
  } finally { db.close(); }
  const merged = baselineStore.collect(databaseFile, manuscriptRoot);
  for (const key of new Set([...current.units.keys(), ...incoming.units.keys()])) {
    const expected = plan.apply.some(item => item.key === key) ? incoming.units.get(key)?.hash : current.units.get(key)?.hash;
    if (merged.units.get(key)?.hash !== expected) fail('UPDATE_REFERENCE_CONFLICT', `병합 후 ${key}의 내용이 예상과 달라 적용을 중단했습니다.`);
  }
  const summary = backup.inspectDatabase(databaseFile);
  const files = [{ relativePath: backup.DB_ENTRY, size: fs.statSync(databaseFile).size, sha256: backup.sha256(fs.readFileSync(databaseFile)) }];
  for (const episode of summary.episodes) {
    const relativePath = 'manuscripts/' + episode.storage_key, file = path.join(manuscriptRoot, ...episode.storage_key.split('/'));
    files.push({ relativePath, size: fs.statSync(file).size, sha256: backup.sha256(fs.readFileSync(file)) });
  }
  const manifest = { formatVersion: backup.FORMAT, createdAt: new Date().toISOString(), applicationVersion, databaseSchemaVersion: summary.databaseSchemaVersion, files, syncBaseline: baseline };
  const output = path.join(destination, 'merged.zip');
  writeZip(output, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...files.map(item => ({ name: item.relativePath, path: path.join(stage, ...item.relativePath.split('/')) }))]);
  backup.validatePackage(output, path.join(destination, 'verified'));
  return output;
}

/** 검증된 ZIP과 현재 DB를 격리 비교하고 충돌이 없을 때만 실행 가능한 ZIP을 준비한다. */
function previewUpdate(root, incomingDirectory, validated, destination, applicationVersion) {
  const currentDatabase = path.join(root, 'novelcompany.db');
  const currentSummary = backup.inspectDatabase(currentDatabase);
  const current = baselineStore.collect(currentDatabase, path.join(root, 'works'));
  const incoming = baselineStore.collect(path.join(incomingDirectory, backup.DB_ENTRY), path.join(incomingDirectory, 'manuscripts'));
  assertCompatible(current, incoming, currentSummary.databaseSchemaVersion, validated.summary.databaseSchemaVersion);
  const localBaseline = baselineStore.readBaseline(root), remoteBaseline = validated.manifest.syncBaseline ?? null;
  const plan = compare(current, incoming, localBaseline, remoteBaseline);
  detectReferenceConflicts(plan, current, incoming);
  const fingerprint = baselineStore.databaseFingerprint(currentDatabase, path.join(root, 'works'));
  let mergedZip = null;
  if (!plan.conflicts.length && plan.apply.length) {
    try { mergedZip = buildMergedZip(root, incomingDirectory, current, incoming, plan, destination, applicationVersion, localBaseline); }
    catch (error) { if (error instanceof RepositoryError && ['UPDATE_REFERENCE_CONFLICT', 'UPDATE_CANON_INVALID'].includes(error.code)) plan.conflicts.push({ key: 'reference', type: 'canon', title: '참조 무결성', reason: error.message }); else throw error; }
  }
  return { ...plan, fingerprint, mergedZip };
}

/** 승인 후 현재 내용이 미리보기와 같은지 다시 확인하여 오래된 병합 ZIP 적용을 차단한다. */
function assertUnchanged(root, fingerprint) {
  if (baselineStore.databaseFingerprint(path.join(root, 'novelcompany.db'), path.join(root, 'works')) !== fingerprint) fail('UPDATE_STALE_PREVIEW', '미리보기 이후 현재 데이터가 변경되었습니다. ZIP을 다시 선택해 비교해 주세요.');
}

module.exports = { assertCompatible, compare, previewUpdate, assertUnchanged };
