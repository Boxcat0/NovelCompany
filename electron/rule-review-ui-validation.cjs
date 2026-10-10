/** 실제 sandbox Renderer에서 RULE/STUB 명시 선택·범위·근거·빈 결과·지연 응답을 검증한다. */
async function exerciseRuleReview(mode = 'normal') {
  /** 실제 React 상태 갱신과 Main 응답을 목표 조건까지 기다린다. */
  async function waitFor(check, label) { const deadline = Date.now() + 12000; await new Promise(resolve => setTimeout(resolve, 40)); while (!check()) { if (Date.now() > deadline) throw new Error('Rule UI: ' + label); await new Promise(resolve => setTimeout(resolve, 25)); } }
  /** 화면 문구로 버튼을 찾는다. */
  function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
  /** 회차 번호로 실제 선택 버튼을 찾는다. */
  function episode(number) { return [...document.querySelectorAll('.viewer-episode-button')].find(node => node.querySelector('.viewer-episode-number').textContent === `${number}화`); }
  /** 조건 실패를 진단 메시지로 전달한다. */
  function check(value, label) { if (!value) throw new Error(label); }
  /** React가 인식하는 검토 방식 선택 이벤트를 발생시킨다. */
  async function select(key) {
    const target = document.getElementById('review-processor');
    check(target && !target.disabled, 'Processor selection disabled');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(target, key);
    target.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 40));
  }
  /** 사용자 제출 경로로 완료된 이력을 기다린다. */
  async function submit(key) {
    await select(key); check(!button('검토부에 제출').disabled, 'Submit disabled'); button('검토부에 제출').click();
    await waitFor(() => document.querySelector('.review-history')?.textContent.includes(key) && document.querySelector('[aria-label="검토"]')?.textContent.includes('제출 상태: 완료'), key + ' completed');
    return [...document.querySelectorAll('.review-history > li')].find(node => node.textContent.includes(key));
  }
  if (mode === 'race') {
    episode(1).click(); await waitFor(() => document.getElementById('episode-number')?.value === '1', 'first editor');
    episode(2).click(); await waitFor(() => document.querySelector('.review-history')?.textContent.includes('Finding 0건'), 'second result');
    await new Promise(resolve => setTimeout(resolve, 650));
    check(!document.querySelector('.review-history')?.textContent.includes('해일의 필요 속성'), 'Previous Rule finding crossed Episode boundary');
    check(document.getElementById('review-processor').value === 'STUB_V1', 'Episode selection default not restored');
    return { lateRuleIgnored: true };
  }
  window.confirm = () => true;
  button('설정').click(); await waitFor(() => document.querySelector('h1')?.textContent === '애플리케이션 설정', 'leave');
  button('작품/회차').click(); await waitFor(() => [...document.querySelectorAll('.work-card-button')].some(node => node.textContent.includes('Task030 UI 작품')), 'work list');
  [...document.querySelectorAll('.work-card-button')].find(node => node.textContent.includes('Task030 UI 작품')).click();
  await waitFor(() => episode(1), 'episodes'); episode(1).click();
  await waitFor(() => document.getElementById('review-processor') && !button('검토부에 제출').disabled, 'editor');
  check(document.getElementById('review-processor').value === 'STUB_V1', 'Default changed from Stub');
  check([...document.getElementById('review-processor').options].map(option => option.value).join(',') === 'STUB_V1,RULE_V1', 'Unapproved Processor option exposed');
  const rule = await submit('RULE_V1'); rule.querySelector('summary').click();
  for (const value of ['CHARACTER_SKILL_ATTRIBUTE_MISMATCH_V1', 'WARNING', 'DETERMINISTIC', 'Canon Record 근거', '한지수', '해일', '물', '불', '등록 관계', '원고의 실제 스킬 사용자']) check(rule.textContent.includes(value), 'Missing Rule detail: ' + value);
  check(rule.querySelectorAll('[data-finding-id]').length === 1 && !rule.querySelector('blockquote'), 'Canon rule invented TXT anchor or duplicate');
  const ruleRunId = rule.dataset.reviewRunId;
  const fetched = await window.novelCompany.reviews.getById(ruleRunId);
  check(fetched.ok && fetched.data.processorKey === 'RULE_V1' && fetched.data.findings[0].relatedCanonRecords.length === 4, 'Rule snapshot DTO mismatch');
  const history = structuredClone(fetched.data.findings);
  const target = document.getElementById('episode-content');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(target, target.value + '\n미저장'); target.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => button('검토부에 제출').disabled, 'dirty blocked');
  episode(2).click(); await waitFor(() => document.getElementById('episode-number')?.value === '2' && !button('검토부에 제출').disabled, 'normal episode');
  const empty = await submit('RULE_V1');
  check(empty.textContent.includes('현재 RULE_V1이 검사한 Canon 관계에서 확인이 필요한 불일치가 발견되지 않았습니다.') && empty.textContent.includes('작품 전체의 무오류를 보장하지 않습니다.'), 'Empty rule overclaims');
  await submit('STUB_V1');
  check(document.querySelector('.review-history').textContent.includes('실제 원고 검토는 아직 수행되지 않았습니다.'), 'Stub meaning changed');
  check(!/원고에 오류가 없습니다|설정이 완벽|전체 Canon 검사 완료/.test(document.querySelector('.review-history').textContent), 'Global correctness claim');
  const job = await window.novelCompany.reviews.getJobByEpisode({ workId: fetched.data.workId, episodeId: (await window.novelCompany.reviews.getById(empty.dataset.reviewRunId)).data.episodeId });
  check(job.ok && job.data.processorKey === 'STUB_V1', 'Selected Stub not stored in Job');
  return { ruleRunId, history, selection: true, ruleDetails: true, zeroFindingsScope: true, stubPreserved: true, dirtyBlocked: true };
}

module.exports = { exerciseRuleReview };
