const { normalizeName, CONTEXTUAL_NAMES, NAME_RESOLUTION_VERSION } = require('./character-name-normalization.cjs');
const wordCharacter = /[\p{L}\p{N}\p{M}_]/u;
const particles = ['께서는', '께서', '에게서는', '에게서', '에게는', '에게', '한테는', '한테', '으로는', '으로', '에서는', '에서', '부터', '까지', '처럼', '보다', '라고', '이라', '로', '은', '는', '이', '가', '을', '를', '의', '와', '과', '도', '만'];

/** NFC 검색용 grapheme view와 원래 UTF-16 범위의 대응을 만들며 TXT 자체는 변형하지 않는다. */
function normalizedView(content) {
  let text = ''; const starts = [], ends = [];
  for (const part of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(content)) {
    const normalized = part.segment.normalize('NFC');
    for (let i = 0; i < normalized.length; i++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
    text += normalized;
  }
  return { text, starts, ends };
}

/** 단어 내부 부분 일치를 거부하고 완결된 한국어 조사 뒤 경계만 보수적으로 허용한다. */
function hasNameBoundary(text, start, end) {
  const previous = Array.from(text.slice(0, start)).at(-1);
  if (previous && wordCharacter.test(previous)) return false;
  const next = Array.from(text.slice(end))[0];
  if (!next || !wordCharacter.test(next)) return true;
  return particles.some(particle => text.startsWith(particle, end) && (!text[end + particle.length] || !wordCharacter.test(Array.from(text.slice(end + particle.length))[0])));
}

/** 현재 Character의 정식 이름/별칭을 후보 evidence로 묶으며 대명사는 해석 대상에서 제외한다. */
function nameIndex(characters) {
  const index = new Map();
  for (const character of characters) for (const [value, type] of [[character.displayName, 'DISPLAY_NAME'], ...(character.registeredAliases ?? []).map(alias => [alias, 'REGISTERED_ALIAS'])]) {
    const name = normalizeName(value);
    if (!name || CONTEXTUAL_NAMES.has(name)) continue;
    if (!index.has(name)) index.set(name, new Map());
    const candidates = index.get(name);
    if (!candidates.has(character.id)) {
      const organization = character.fields.find(field => field.key === 'organization' && field.valueType === 'REFERENCE_ONE')?.value ?? null;
      candidates.set(character.id, { recordId: character.id, displayName: character.displayName, matchTypes: [], organization });
    }
    if (!candidates.get(character.id).matchTypes.includes(type)) candidates.get(character.id).matchTypes.push(type);
  }
  return index;
}

/** 긴 명칭을 우선하고 구조 표기를 제외해 등록 후보만 반환하며 실제 지시 대상은 단정하지 않는다. */
function resolveCharacterNames(content, scenes, characters) {
  const view = normalizedView(content); const index = nameIndex(characters); const mentions = []; const covered = [];
  const names = [...index.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'));
  for (const name of names) {
    let offset = view.text.indexOf(name);
    while (offset >= 0) {
      const end = offset + name.length;
      const range = { start: view.starts[offset], end: view.ends[end - 1] };
      const scene = scenes.find(item => range.start >= item.originalRange.start && range.end <= item.originalRange.end);
      const structural = scene?.notationOccurrences.some(item => !['DIALOGUE', 'INNER_OR_CONTRACT_DIALOGUE'].includes(item.type) && range.start < item.range.end && range.end > item.range.start);
      if (scene && !structural && hasNameBoundary(view.text, offset, end) && !covered.some(item => range.start < item.end && range.end > item.start)) {
        covered.push(range);
        const candidates = [...index.get(name).values()].map(candidate => ({ ...candidate, matchTypes: [...candidate.matchTypes].sort() })).sort((a, b) => a.recordId.localeCompare(b.recordId, 'en'));
        const quote = scene.notationOccurrences.find(item => ['DIALOGUE', 'INNER_OR_CONTRACT_DIALOGUE'].includes(item.type) && item.range.start <= range.start && item.range.end >= range.end);
        mentions.push({ text: content.slice(range.start, range.end), normalizedName: name, sceneIndex: scene.index, sceneIdentity: scene.identity,
          range, quoteContext: quote?.type ?? null, status: candidates.length === 1 ? 'MATCHED' : 'AMBIGUOUS',
          recordId: candidates.length === 1 ? candidates[0].recordId : null, candidateIds: candidates.map(candidate => candidate.recordId), candidates, certainty: 'REGISTERED_NAME_CANDIDATES' });
      }
      offset = view.text.indexOf(name, end);
    }
  }
  return mentions.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
}

module.exports = { resolveCharacterNames, NAME_RESOLUTION_VERSION };
