const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-staging-'));
process.env.NOVEL_COMPANY_DATA_DIR = root;
const { initializeDatabase, closeDatabase, getDatabase } = require('../database/database.cjs');
const staging = require('../database/repositories/canon-staging-repository.cjs');
const promotion = require('./canon-promotion.cjs');
const { parseImport, MAX_BYTES } = require('./canon-import.cjs');
const { createScope, documentFixture, readySelection, COUNTS } = require('./testing/staging-fixtures.cjs');
/** 허용된 공개 오류 코드와 한국어 메시지가 반환되는지 검사한다. */
function rejects(action, code) { assert.throws(action, error => error.code === code && /[가-힣]/.test(error.message), code); }
/** 모든 영속 행을 비교하여 미리보기·실패가 어떤 데이터도 바꾸지 않았음을 확인한다. */
function snapshot() { return JSON.stringify(getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, getDatabase().prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])); }
/** 가상 원본을 실제 Preview 및 transaction Import 경로로 저장한다. */
function importFixture(scope, document = documentFixture()) {
  const parsed = parseImport(Buffer.from(JSON.stringify(document))), preview = staging.previewImport(scope, parsed);
  return { parsed, preview, result: staging.importCandidates(scope, parsed, 'fixture.json', preview.fingerprint) };
}
/** 불확정 값·원본·중복·범위·편집 충돌 및 Preview의 읽기 전용 계약을 확인한다. */
function importCases() {
  const scope = createScope(), other = createScope(), document = documentFixture();
  const recordRepository = require('../database/repositories/canon-record-repository.cjs');
  const worldSet = staging.definitions(scope).find(set => set.key === 'world');
  const original = recordRepository.create({ canonSpaceId: scope.canonSpaceId, setId: worldSet.id }, { displayName: '보존할 기존 공식 세계', fieldValues: {} });
  const parsed = parseImport(Buffer.from(JSON.stringify(document))), before = snapshot();
  const preview = staging.previewImport(scope, parsed);
  assert.equal(snapshot(), before); assert.deepEqual(preview.counts, COUNTS); assert.equal(preview.total, 168); assert.equal(preview.privateCount, 8);
  assert.equal(staging.importCandidates(scope, parsed, 'fixture.json', preview.fingerprint).createdCount, 168);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_records').get().n, 1);
  assert.deepEqual(recordRepository.getById({ canonSpaceId: scope.canonSpaceId, setId: worldSet.id }, original.id), original);
  assert.equal(JSON.parse(getDatabase().prepare('SELECT source_snapshot FROM canon_staging_imports').get().source_snapshot).author_notes.preserved, document.author_notes.preserved);
  const repeated = staging.previewImport(scope, parsed); assert.equal(repeated.alreadyImported, true);
  assert.equal(staging.importCandidates(scope, parsed, 'same.json', repeated.fingerprint).createdCount, 0); assert.equal(staging.list(scope).length, 168);
  const rows = staging.list(scope), row = rows.find(row => row.draftKey === 'character:0');
  const saved = staging.update(scope, row.id, { displayName: '작가 임시 수정', fields: row.candidate.fields, references: row.candidate.references, authorPrivate: false, expectedRevision: 1 });
  assert.equal(saved.revision, 2); assert.equal(saved.candidate.references.origin_location, null);
  rejects(() => staging.update(scope, row.id, { displayName: '오래된 수정', fields: {}, references: {}, authorPrivate: false, expectedRevision: 1 }), 'CANON_STAGING_REVISION_CONFLICT');
  rejects(() => staging.get(other, row.id), 'CANON_STAGING_NOT_FOUND');
  rejects(() => staging.list({ ...scope, workId: other.workId }), 'CANON_STAGING_SCOPE_INVALID');
  rejects(() => promotion.preview(other, [{ id: row.id, expectedRevision: 2 }]), 'CANON_STAGING_NOT_FOUND');
  document.canon_sets.character.candidates[0].fields.description = '변경된 원본';
  const changed = parseImport(Buffer.from(JSON.stringify(document))), conflict = staging.previewImport(scope, changed), unchanged = snapshot();
  assert.equal(conflict.items.find(item => item.draftKey === row.draftKey).action, 'CONFLICT_EDITED');
  rejects(() => staging.importCandidates(scope, changed, 'changed.json', conflict.fingerprint), 'CANON_IMPORT_CONFLICT'); assert.equal(snapshot(), unchanged);
  const duplicate = documentFixture(); duplicate.canon_sets.world.candidates.push(duplicate.canon_sets.world.candidates[0]);
  rejects(() => parseImport(Buffer.from(JSON.stringify(duplicate))), 'CANON_IMPORT_DUPLICATE_KEY');
  rejects(() => parseImport(Buffer.from('{"__proto__":{}}')), 'CANON_IMPORT_INVALID');
  rejects(() => parseImport(Buffer.alloc(MAX_BYTES + 1)), 'CANON_IMPORT_LIMIT');
  rejects(() => parseImport(Buffer.from('{')), 'CANON_IMPORT_INVALID');
  const deep = { ...documentFixture(), extra: {} }; let cursor = deep.extra; for (let i = 0; i < 25; i++) { cursor.child = {}; cursor = cursor.child; }
  rejects(() => parseImport(Buffer.from(JSON.stringify(deep))), 'CANON_IMPORT_LIMIT');
  const overview = promotion.overview(scope); assert.equal(overview.records.length, 168);
  for (const key of ['passive:5', 'skill:12', 'character:0']) assert.equal(overview.records.find(row => row.draftKey === key).validation.status, 'NEEDS_INPUT');
  assert.equal(overview.records.find(row => row.draftKey === 'character:62').validation.status, 'DRAFT');
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_records').get().n, 1);
  assert.deepEqual(recordRepository.getById({ canonSpaceId: scope.canonSpaceId, setId: worldSet.id }, original.id), original);
  const rollbackScope = createScope(), rollbackParsed = parseImport(Buffer.from(JSON.stringify(documentFixture()))), rollbackPreview = staging.previewImport(rollbackScope, rollbackParsed), rollbackBefore = snapshot();
  getDatabase().exec("CREATE TEMP TRIGGER fail_staging_import AFTER INSERT ON canon_staging_records WHEN NEW.draft_key = 'world:1' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  rejects(() => staging.importCandidates(rollbackScope, rollbackParsed, 'rollback.json', rollbackPreview.fingerprint), 'CANON_STAGING_SAVE_FAILED');
  getDatabase().exec('DROP TRIGGER fail_staging_import'); assert.equal(snapshot(), rollbackBefore);
  console.log('PASS Import/Staging: 168 virtual candidates/12 sets/8 private; read-only preview, raw metadata, dedupe, conflicts, revisions, scope, parser limits, incomplete values, official Canon unchanged');
  return scope;
}
/** 실제 Repository 등록을 의존 순서대로 실행하고 전체 rollback·UUID 연결·재실행을 확인한다. */
function promotionCases() {
  const scope = createScope(); importFixture(scope);
  const rows = staging.list(scope), selection = readySelection(rows), before = snapshot();
  const preview = promotion.preview(scope, selection); assert.equal(preview.canExecute, true); assert.equal(snapshot(), before);
  const privateRow = rows.find(row => row.draftKey === 'character:62');
  assert.equal(promotion.preview(scope, [{ id: privateRow.id, expectedRevision: 1 }]).entries[0].status, 'DRAFT');
  const missing = rows.find(row => row.draftKey === 'passive:5');
  assert.equal(promotion.preview(scope, [{ id: missing.id, expectedRevision: 1 }]).canExecute, false);
  getDatabase().exec("CREATE TEMP TRIGGER fail_staging_promotion AFTER INSERT ON canon_records WHEN NEW.display_name LIKE '%character%' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => promotion.promote(scope, selection, preview.fingerprint)); assert.equal(snapshot(), before);
  getDatabase().exec('DROP TRIGGER fail_staging_promotion');
  const result = promotion.promote(scope, selection, preview.fingerprint); assert.equal(result.entries.length, 13);
  assert.ok(result.entries.every(row => typeof row.recordId === 'string'));
  const promoted = staging.list(scope).filter(row => row.promotion); assert.equal(promoted.length, 13);
  const after = snapshot(), again = promotion.preview(scope, selection); promotion.promote(scope, selection, again.fingerprint); assert.equal(snapshot(), after);
  const character = promoted.find(row => row.draftKey === 'character:1'), attribute = promoted.find(row => row.draftKey === 'attribute:0');
  assert.ok(getDatabase().prepare('SELECT 1 FROM canon_record_references WHERE record_id = ? AND target_record_id = ?').get(character.promotion.recordId, attribute.promotion.recordId));
  rejects(() => promotion.promote(scope, [{ id: privateRow.id, expectedRevision: 1 }], staging.fingerprint(scope)), 'CANON_STAGING_PRIVATE_BLOCKED');
  const unselected = rows.find(row => row.draftKey === 'world:1');
  const stale = promotion.preview(scope, [{ id: unselected.id, expectedRevision: 1 }]);
  staging.update(scope, unselected.id, { displayName: unselected.candidate.display_name, fields: { description: '수정' }, references: {}, authorPrivate: false, expectedRevision: 1 });
  rejects(() => promotion.promote(scope, [{ id: unselected.id, expectedRevision: 1 }], stale.fingerprint), 'CANON_STAGING_STALE_PREVIEW');
  const world = promoted.find(row => row.draftKey === 'world:0'), same = rows.find(row => row.draftKey === 'world:3');
  staging.update(scope, same.id, { displayName: world.candidate.display_name, fields: world.candidate.fields, references: {}, authorPrivate: false, expectedRevision: 1 });
  assert.equal(promotion.preview(scope, [{ id: same.id, expectedRevision: 2 }]).canExecute, false);
  const linkedSelection = [{ id: same.id, expectedRevision: 2, existingRecordId: world.promotion.recordId }], linked = promotion.preview(scope, linkedSelection), canonBeforeLink = getDatabase().prepare('SELECT * FROM canon_records ORDER BY id').all();
  assert.equal(linked.canExecute, true); promotion.promote(scope, linkedSelection, linked.fingerprint);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM canon_records ORDER BY id').all(), canonBeforeLink); assert.equal(staging.get(scope, same.id).promotion.mode, 'LINK');
  const self = rows.find(row => row.draftKey === 'contract:1');
  staging.update(scope, self.id, { displayName: self.candidate.display_name, fields: self.candidate.fields, references: { grantor_character: 'character:1', grantee_character: 'character:1' }, authorPrivate: false, expectedRevision: 1 });
  const selfPlan = promotion.preview(scope, [{ id: self.id, expectedRevision: 2 }]); assert.equal(selfPlan.canExecute, false); assert.ok(selfPlan.entries[0].errors[0].includes('서로 다른'));
  const privateSaved = staging.update(scope, privateRow.id, { displayName: privateRow.candidate.display_name, fields: privateRow.candidate.fields, references: privateRow.candidate.references, authorPrivate: false, expectedRevision: 1 });
  assert.equal(privateSaved.candidate.author_private, true);
  const passive = rows.find(row => row.draftKey === 'passive:1'), owner = rows.find(row => row.draftKey === 'character:3'), competing = rows.find(row => row.draftKey === 'character:4');
  staging.update(scope, passive.id, { displayName: passive.candidate.display_name, fields: { ...passive.candidate.fields, passive_type: 'UNIQUE' }, references: {}, authorPrivate: false, expectedRevision: 1 });
  for (const row of [owner, competing]) staging.update(scope, row.id, { displayName: row.candidate.display_name, fields: row.candidate.fields, references: { ...row.candidate.references, passives: ['passive:1'] }, authorPrivate: false, expectedRevision: 1 });
  const firstOwner = [{ id: owner.id, expectedRevision: 2 }, { id: passive.id, expectedRevision: 2 }], ownershipPreview = promotion.preview(scope, firstOwner); assert.equal(ownershipPreview.canExecute, true); promotion.promote(scope, firstOwner, ownershipPreview.fingerprint);
  const secondOwner = promotion.preview(scope, [{ id: competing.id, expectedRevision: 2 }]); assert.equal(secondOwner.canExecute, false); assert.ok(secondOwner.entries[0].errors[0].includes('고유 패시브'));
  const bad = rows.find(row => row.draftKey === 'skill:11'); staging.update(scope, bad.id, { displayName: bad.candidate.display_name, fields: bad.candidate.fields, references: { required_attribute: 'world:0' }, authorPrivate: false, expectedRevision: 1 });
  assert.equal(promotion.preview(scope, [{ id: bad.id, expectedRevision: 2 }]).canExecute, false);
  const sameNameWorld = rows.find(row => row.draftKey === 'world:2'), sameNameAuthority = rows.find(row => row.draftKey === 'authority:1');
  for (const row of [sameNameWorld, sameNameAuthority]) staging.update(scope, row.id, { displayName: '가상 동명 후보', fields: row.candidate.fields, references: row.candidate.references, authorPrivate: false, expectedRevision: 1 });
  const names = [sameNameWorld, sameNameAuthority].map(row => ({ id: row.id, expectedRevision: 2 })), namesPreview = promotion.preview(scope, names); assert.equal(namesPreview.canExecute, true); const namesResult = promotion.promote(scope, names, namesPreview.fingerprint); assert.notEqual(namesResult.entries[0].recordId, namesResult.entries[1].recordId);
  const changedSource = documentFixture(); changedSource.canon_sets.world.candidates[0].fields.description = '승인 후 변경된 원본';
  assert.equal(staging.previewImport(scope, parseImport(Buffer.from(JSON.stringify(changedSource)))).items.find(item => item.draftKey === 'world:0').action, 'CONFLICT_PROMOTED');
  const originalParsed = parseImport(Buffer.from(JSON.stringify(documentFixture()))), reimport = staging.previewImport(scope, originalParsed), reimportBefore = snapshot();
  assert.equal(reimport.alreadyImported, true); staging.importCandidates(scope, originalParsed, 'reimport.json', reimport.fingerprint); assert.equal(snapshot(), reimportBefore);
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
  console.log('PASS Promotion: Repository/dependency order/rollback/private/required fields/UUID/replay/stale; explicit link without overwrite; self relation/UNIQUE ownership/wrong reference Set rejected; same name different Set preserved');
  return scope;
}
/** 격리 DB에서 요청한 검증을 실행하고 임시 파일만 정리한다. */
async function run() {
  try {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    if (process.argv[2] === 'promotion') promotionCases(); else importCases();
    if (process.argv[2] === 'staging') {
      await require('./canon-staging-compatibility-validation.cjs').runCompatibility(root);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const ui = spawnSync(require('electron'), [path.join(__dirname, 'canon-staging-ui-validation.cjs'), path.join(root, 'canon-staging-ui-profile')], { env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
      process.stdout.write(ui.stdout ?? ''); process.stderr.write(ui.stderr ?? ''); assert.equal(ui.status, 0, ui.error?.message ?? 'Staging Electron UI');
    }
  } finally { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
