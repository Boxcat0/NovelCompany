const { createHash } = require('node:crypto');

/** 객체 key 순서를 고정해 기존 Canon hash와 새 장면 hash가 같은 직렬화 규칙을 사용한다. */
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
}

/** 원문 문자열을 정규화하지 않고 UTF-8 SHA-256으로 지문화한다. */
function hashText(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/** 시각이나 객체 삽입 순서에 영향받지 않는 구조화 입력 hash를 만든다. */
function hashValue(value) { return hashText(canonicalStringify(value)); }

module.exports = { canonicalStringify, hashText, hashValue };
