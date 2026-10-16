const { createHash } = require('node:crypto');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const MAX_BYTES = 4 * 1024 * 1024;
const SET_KEYS = ['world', 'location', 'city', 'organization', 'attribute', 'skill', 'character', 'authority', 'servant', 'passive', 'contract', 'relationship'];

/** 원문·경로를 포함하지 않는 한국어 Import 오류를 만든다. */
function fail(code, message) { throw new RepositoryError(code, message); }
/** 배열과 null을 제외한 JSON 객체인지 검사한다. */
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** 원본 보존 및 미리보기 식별에 사용할 SHA-256을 계산한다. */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
/** 깊이·전체 노드 수·비정상 키·비정상 문자열을 제한하여 메타데이터까지 안전하게 보존한다. */
function inspectJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 100000 || depth > 24) fail('CANON_IMPORT_LIMIT', 'JSON의 깊이 또는 항목 수가 허용 범위를 초과했습니다.');
  if (typeof value === 'string' && (value.length > 100000 || value.includes('\0'))) fail('CANON_IMPORT_LIMIT', 'JSON 문자열의 길이 또는 문자를 확인해 주세요.');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('CANON_IMPORT_INVALID', 'JSON에 유효하지 않은 숫자가 있습니다.');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 200) fail('CANON_IMPORT_INVALID', 'JSON에 허용하지 않는 속성 이름이 있습니다.');
    inspectJson(child, depth + 1, budget);
  }
}
/** 미확정 값은 유지하되 후보 식별자와 기본 컨테이너 타입은 엄격하게 검사한다. */
function validateCandidate(candidate, setKey) {
  if (!object(candidate) || typeof candidate.draft_key !== 'string' || !candidate.draft_key.startsWith(setKey + ':') || candidate.draft_key.length > 200 || /\s/.test(candidate.draft_key) || candidate.draft_key.length <= setKey.length + 1 || typeof candidate.display_name !== 'string' || candidate.display_name.length > 200 || !object(candidate.fields) || !object(candidate.references)) fail('CANON_IMPORT_CANDIDATE_INVALID', '후보의 논리키·대표명·fields·references 형식을 확인해 주세요.');
  if (candidate.source_episodes !== undefined && (!Array.isArray(candidate.source_episodes) || candidate.source_episodes.length > 2000 || candidate.source_episodes.some(number => !Number.isSafeInteger(number) || number < 1))) fail('CANON_IMPORT_CANDIDATE_INVALID', '출처 회차는 양의 정수 목록으로 입력해 주세요.');
  for (const key of ['author_private', 'import_ready']) if (candidate[key] !== undefined && typeof candidate[key] !== 'boolean') fail('CANON_IMPORT_CANDIDATE_INVALID', '비공개 및 원본 준비 표시는 참/거짓 값이어야 합니다.');
  return candidate;
}
/** 파일 bytes를 제한된 JSON 계약으로 읽으며 모든 최상위·후보 메타데이터를 유지한다. */
function parseImport(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) fail('CANON_IMPORT_LIMIT', 'JSON 파일은 비어 있지 않은 4 MiB 이하 파일이어야 합니다.');
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { fail('CANON_IMPORT_INVALID', 'UTF-8 JSON 문법을 확인해 주세요.'); }
  inspectJson(document);
  if (document?.format_version !== undefined && document.format_version !== 'NOVELCOMPANY_CANON_JSON_V1') fail('CANON_IMPORT_FORMAT_UNSUPPORTED', '지원하지 않는 Canon JSON 형식 버전입니다.');
  if (!object(document) || document.project !== 'NovelCompany' || typeof document.version !== 'string' || !document.version.trim() || typeof document.work_title !== 'string' || !object(document.canon_sets) || !Object.keys(document.canon_sets).length || Object.keys(document.canon_sets).length > 12) fail('CANON_IMPORT_FORMAT_UNSUPPORTED', '지원하는 NovelCompany Canon JSON 형식이 아닙니다.');
  const candidates = [], seen = new Set(), counts = {};
  for (const [setKey, set] of Object.entries(document.canon_sets)) {
    if (!SET_KEYS.includes(setKey) || !object(set) || !Array.isArray(set.candidates)) fail('CANON_IMPORT_FORMAT_UNSUPPORTED', '지원하지 않는 CanonSet 또는 후보 목록 형식입니다.');
    counts[setKey] = set.candidates.length;
    for (const candidate of set.candidates) {
      validateCandidate(candidate, setKey);
      if (seen.has(candidate.draft_key)) fail('CANON_IMPORT_DUPLICATE_KEY', '파일 안에 중복된 draft_key가 있습니다. 원본을 확인해 주세요.');
      seen.add(candidate.draft_key); candidates.push({ setKey, candidate });
      if (candidates.length > 2000) fail('CANON_IMPORT_LIMIT', '한 파일의 후보는 최대 2,000개까지 지원합니다.');
    }
  }
  return { document, candidates, counts, sourceHash: hash(bytes), snapshot: bytes.toString('utf8') };
}
module.exports = { MAX_BYTES, SET_KEYS, object, hash, inspectJson, validateCandidate, parseImport, fail };
