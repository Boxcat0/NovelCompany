const { buildEpisodeWorkContext } = require('./episode-work-context-builder.cjs');
const SET_KEYS = new Set(['character', 'location', 'world', 'organization', 'attribute', 'skill', 'passive', 'authority', 'servant', 'relationship', 'contract']);
const CHARACTER_FIELDS = new Set(['origin_world', 'origin_location', 'current_location', 'organization', 'attributes', 'skills', 'passives']);

/** 원문 UTF-16 code unit의 [start,end) 범위를 유지하며 인용문, 알림, 표제, 능력 표기를 순서대로 읽는다. */
function parseNotation(content) {
  const occurrences = [], warnings = [];
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if ((c === '"' || c === "'") && content[i - 1] !== '\\') {
      if (!quote) quote = { delimiter: c, start: i };
      else if (quote.delimiter === c) {
        occurrences.push({ type: c === '"' ? 'DIALOGUE' : 'INNER_OR_CONTRACT_DIALOGUE', range: { start: quote.start, end: i + 1 }, raw: content.slice(quote.start, i + 1), quoteContext: null });
        quote = null;
      }
      continue;
    }
    if (c === ']' || c === '}') {
      warnings.push({ range: { start: i, end: i + 1 }, message: '여는 기호가 없는 닫는 기호입니다.' });
      continue;
    }
    if (c !== '[' && c !== '{') continue;
    const close = c === '[' ? ']' : '}';
    const end = content.indexOf(close, i + 1);
    const lineEnd = content.slice(i + 1).search(/[\r\n]/);
    if (end < 0 || (lineEnd >= 0 && end > i + 1 + lineEnd)) {
      warnings.push({ range: { start: i, end: i + 1 }, message: '닫히지 않은 원고 기호입니다.' });
      continue;
    }
    const raw = content.slice(i, end + 1), inner = content.slice(i + 1, end).trim();
    let type = 'INVALID', name = inner, left = null;
    if (inner && !/[\[\]{}]/.test(inner)) {
      if (c === '[') {
        const before = content.slice(0, i).split(/[\r\n]/).at(-1);
        const after = content.slice(end + 1).split(/[\r\n]/)[0];
        if (/^알림\s*:/.test(inner)) type = 'SYSTEM_NOTIFICATION';
        else if (!quote && !before.trim() && !after.trim()) type = 'LOCATION_HEADER';
      } else {
        const parts = inner.split(':').map(part => part.trim());
        if (parts.length === 1) type = 'SKILL_OR_PASSIVE';
        else if (parts.length === 2 && parts.every(Boolean)) {
          left = parts[0]; name = parts[1]; type = left === '권속' ? 'SERVANT' : 'AUTHORITY';
        }
      }
    }
    const occurrence = { type, raw, name, left, range: { start: i, end: end + 1 }, quoteContext: quote ? (quote.delimiter === '"' ? 'DIALOGUE' : 'INNER_OR_CONTRACT_DIALOGUE') : null };
    occurrences.push(occurrence);
    if (type === 'INVALID') warnings.push({ range: occurrence.range, message: '빈 표기 또는 해석할 수 없는 원고 기호입니다.' });
    i = end;
  }
  if (quote) warnings.push({ range: { start: quote.start, end: content.length }, message: '닫히지 않은 인용문입니다.' });
  return { occurrences: occurrences.sort((a, b) => a.range.start - b.range.start), warnings };
}

/** 실제 DTO의 Reference field만 배열로 읽고 scalar 값은 참조로 취급하지 않는다. */
function references(record, keys) {
  return record.fields.filter(field => keys.includes(field.key) && ['REFERENCE_ONE', 'REFERENCE_MANY'].includes(field.valueType)).flatMap(field => Array.isArray(field.value) ? field.value : field.value ? [field.value] : []);
}

/** 후보 수에 따라 연결 상태를 정하며 동명이인 후보를 임의로 선택하지 않는다. */
function resolveCandidates(candidates) {
  return { status: candidates.length === 1 ? 'MATCHED' : candidates.length ? 'AMBIGUOUS' : 'NOT_FOUND', recordId: candidates.length === 1 ? candidates[0].id : null, candidateIds: candidates.map(record => record.id).sort() };
}

/** FULL_CANON DTO 하나에서 Scene, 1-hop 관련 Canon, 능력 보유 검증을 읽기 전용으로 파생한다. */
function buildReviewContext(workContext) {
  if (workContext.scope !== 'FULL_CANON') throw new Error('FULL_CANON context is required');
  const content = workContext.episode.content;
  const parsed = parseNotation(content);
  const records = workContext.canon.sets.filter(set => SET_KEYS.has(set.key)).flatMap(set => set.records.map(record => ({ ...record, setKey: set.key, setLabel: set.label })));
  const byId = new Map(records.map(record => [record.id, record]));
  const headings = parsed.occurrences.filter(item => item.type === 'LOCATION_HEADER');
  const starts = [...new Set([0, ...headings.map(item => item.range.start)])];
  const scenes = starts.map((start, index) => {
    const end = starts[index + 1] ?? content.length;
    const heading = headings.find(item => item.range.start === start);
    const timeHintRaw = heading?.name.startsWith('그 시각 ') ? '그 시각' : null;
    const locationCandidate = heading ? (timeHintRaw ? heading.name.slice(5).trim() : heading.name) : null;
    return { index: index + 1, originalRange: { start, end }, locationHeading: heading?.name ?? null, timeHintRaw, locationCandidate, resolvedLocation: resolveCandidates(records.filter(record => record.setKey === 'location' && record.displayName === locationCandidate)), narration: { type: 'UNKNOWN', characterId: null }, notationOccurrences: parsed.occurrences.filter(item => item.range.start >= start && item.range.start < end).map(item => ({ ...item })), directMentions: [], selectedCanonIds: [] };
  });
  const selected = new Map(), reasons = [], unresolvedMentions = [], checks = [];
  /** 같은 Record는 한 번만 보관하고 Scene별 선택 경로는 중복 없이 누적한다. */
  function select(id, reason, scene, sourceRecordId = null, range = null) {
    const record = byId.get(id);
    if (!record) return;
    selected.set(id, record);
    if (!scene.selectedCanonIds.includes(id)) scene.selectedCanonIds.push(id);
    const entry = { recordId: id, reason, sceneIndex: scene.index, sourceRecordId, range };
    if (!reasons.some(item => JSON.stringify(item) === JSON.stringify(entry))) reasons.push(entry);
  }
  const names = [...new Set(records.map(record => record.displayName).filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'));
  for (const scene of scenes) {
    const { start, end } = scene.originalRange;
    const covered = [];
    for (const name of names) {
      let offset = content.indexOf(name, start);
      while (offset >= start && offset + name.length <= end) {
        const range = { start: offset, end: offset + name.length };
        if (!covered.some(item => range.start < item.end && range.end > item.start)) {
          covered.push(range);
          const notation = scene.notationOccurrences.find(item => item.range.start <= offset && item.range.end >= range.end && ['LOCATION_HEADER', 'SERVANT', 'SKILL_OR_PASSIVE', 'AUTHORITY'].includes(item.type));
          const keys = notation?.type === 'LOCATION_HEADER' ? ['location'] : notation?.type === 'SERVANT' ? ['servant'] : notation?.type === 'SKILL_OR_PASSIVE' ? ['skill', 'passive'] : notation?.type === 'AUTHORITY' ? [] : [...SET_KEYS];
          const resolution = resolveCandidates(records.filter(record => keys.includes(record.setKey) && record.displayName === name));
          scene.directMentions.push({ name, range, ...resolution });
          if (resolution.recordId) select(resolution.recordId, 'DIRECT_MENTION', scene, null, range);
          else if (resolution.status === 'AMBIGUOUS') unresolvedMentions.push({ raw: name, range, sceneIndex: scene.index, status: 'AMBIGUOUS', candidateIds: resolution.candidateIds });
        }
        offset = content.indexOf(name, offset + name.length);
      }
    }
    if (scene.resolvedLocation.recordId) select(scene.resolvedLocation.recordId, 'LOCATION_HEADER', scene);
    for (const notation of scene.notationOccurrences.filter(item => ['SKILL_OR_PASSIVE', 'SERVANT', 'AUTHORITY'].includes(item.type))) {
      const candidates = notation.type === 'AUTHORITY' ? [] : records.filter(record => (notation.type === 'SERVANT' ? record.setKey === 'servant' : ['skill', 'passive'].includes(record.setKey)) && record.displayName === notation.name);
      notation.resolution = notation.type === 'AUTHORITY' ? { status: 'UNRESOLVED', recordId: null, candidateIds: [] } : resolveCandidates(candidates);
      notation.canonType = notation.type === 'SKILL_OR_PASSIVE' && candidates.length === 1 ? candidates[0].setKey.toUpperCase() : notation.type;
      if (notation.resolution.recordId) select(notation.resolution.recordId, 'NOTATION', scene, null, notation.range);
      if (notation.type !== 'SKILL_OR_PASSIVE') continue;
      const boundary = Math.max(start, content.lastIndexOf('\n', notation.range.start - 1) + 1, content.lastIndexOf('.', notation.range.start - 1) + 1, content.lastIndexOf('!', notation.range.start - 1) + 1, content.lastIndexOf('?', notation.range.start - 1) + 1);
      const prefix = content.slice(boundary, notation.range.start);
      const subject = prefix.match(/^\s*([^\s{}"'.,!?]+?)(?:은|는|이|가)\s*$/)?.[1];
      const action = /^(?:을|를)\s*(?:사용했다|발동했다|사용한다|발동한다)(?:[.!?]|\s*$)/.test(content.slice(notation.range.end, end).split(/[\r\n]/)[0]);
      const quoted = notation.quoteContext || parsed.occurrences.some(item => ['DIALOGUE', 'INNER_OR_CONTRACT_DIALOGUE'].includes(item.type) && item.range.start < notation.range.start && item.range.end > notation.range.end);
      const actors = !quoted && action && subject && !['나', '내', '그분', '그', '그녀', '그녀석'].includes(subject) ? records.filter(record => record.setKey === 'character' && record.displayName === subject) : [];
      const actor = actors.length === 1 ? actors[0] : null;
      if (actor) select(actor.id, 'EXPLICIT_ABILITY_ACTOR', scene, null, { start: boundary, end: notation.range.start });
      let result = notation.resolution.status === 'NOT_FOUND' ? 'CANON_NOT_FOUND' : notation.resolution.status === 'AMBIGUOUS' || actors.length > 1 ? 'AMBIGUOUS' : !actor ? 'UNVERIFIABLE_OWNER' : references(actor, [notation.canonType === 'SKILL' ? 'skills' : 'passives']).some(ref => ref.recordId === notation.resolution.recordId) ? 'MATCHED' : 'MISMATCH_CANDIDATE';
      checks.push({ raw: notation.raw, range: notation.range, sceneIndex: scene.index, type: notation.canonType, abilityRecordId: notation.resolution.recordId, actorCharacterId: actor?.id ?? null, result, evidence: actor ? '명시적인 단일 주체의 사용 문장과 Canon 보유 참조 ID를 비교했습니다.' : '사용 주체를 확정할 수 없습니다.', unresolvedReason: result === 'MATCHED' ? null : result === 'MISMATCH_CANDIDATE' ? '보유 참조가 없습니다. 확정적인 설정 오류를 의미하지 않습니다.' : result === 'CANON_NOT_FOUND' ? '능력 Canon이 없습니다.' : result === 'AMBIGUOUS' ? '이름에 여러 Canon 후보가 있습니다.' : '화자 또는 사용 주체가 미확정입니다.' });
    }
    const core = scene.selectedCanonIds.map(id => byId.get(id)).filter(record => record.setKey === 'character');
    for (const character of core) {
      for (const ref of references(character, [...CHARACTER_FIELDS])) select(ref.recordId, 'CHARACTER_REFERENCE', scene, character.id);
      for (const record of records) {
        const keys = record.setKey === 'authority' || record.setKey === 'servant' ? ['owner_character'] : record.setKey === 'relationship' ? ['source_character', 'target_character'] : record.setKey === 'contract' ? ['grantor_character', 'grantee_character'] : [];
        const refs = references(record, keys);
        if (!refs.some(ref => ref.recordId === character.id)) continue;
        select(record.id, 'CHARACTER_' + record.setKey.toUpperCase(), scene, character.id);
        // 관계 상대는 identity만 제공한다. 상대 Character의 전체 Canon이나 관계를 확장하지 않는다.
        for (const ref of refs.filter(ref => ref.recordId !== character.id)) reasons.push({ recordId: ref.recordId, reason: 'RELATED_PARTICIPANT', sceneIndex: scene.index, sourceRecordId: record.id, range: null });
      }
    }
    for (const match of content.slice(start, end).matchAll(/그분|그 녀석|그녀석|그 사람/g)) unresolvedMentions.push({ raw: match[0], sceneIndex: scene.index, range: { start: start + match.index, end: start + match.index + match[0].length }, status: 'UNKNOWN', candidateIds: [] });
    scene.selectedCanonIds.sort();
  }
  const selectedRecords = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const selectedSets = workContext.canon.sets.filter(set => selectedRecords.some(record => record.setKey === set.key)).map(set => ({ key: set.key, label: set.label })).sort((a, b) => a.key.localeCompare(b.key, 'en'));
  const warnings = [...parsed.warnings, ...scenes.flatMap(scene => scene.notationOccurrences.filter(item => item.resolution && item.resolution.status !== 'MATCHED').map(item => ({ range: item.range, message: item.resolution.status === 'AMBIGUOUS' ? '능력 표기에 여러 Canon 후보가 있습니다.' : item.type === 'AUTHORITY' ? '권능 표기와 Canon을 연결할 확정 규칙이 없습니다.' : '능력 표기와 일치하는 Canon이 없습니다.' }))), ...scenes.filter(scene => scene.locationHeading && scene.resolvedLocation.status !== 'MATCHED').map(scene => ({ range: scene.originalRange, message: '장소 Canon 연결이 미등록 또는 모호한 상태입니다.' }))];
  return { scope: 'RELEVANT_CANON', selectorVersion: 'RELEVANT_CANON_V1', rangeUnit: 'UTF16_HALF_OPEN', work: { ...workContext.work }, episode: { ...workContext.episode }, scenes, relevantCanon: { selectedSets, selectedRecords, selectionReasons: reasons }, abilityOwnershipChecks: checks, unresolvedMentions, warnings };
}

/** Preview와 Review 실행이 같은 WorkContext 출발점과 순수 분석 함수를 사용하게 한다. */
async function buildEpisodeReviewContext(storage, input) {
  return buildReviewContext(await buildEpisodeWorkContext(storage, input));
}

module.exports = { parseNotation, buildReviewContext, buildEpisodeReviewContext };
