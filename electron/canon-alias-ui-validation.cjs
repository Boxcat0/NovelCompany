/** sandbox Renderer에서 Alias CRUD·draft·후보 Preview 및 실제 검토를 하지 않은 Stub 안내를 검증한다. */
async function exerciseAliases(mode = 'normal') {
  /** React 상태와 Main 응답을 목표 조건까지 기다린다. */
  async function waitFor(check, label) { const deadline = Date.now() + 10000; await new Promise(resolve => setTimeout(resolve, 40)); while (!check()) { if (Date.now() > deadline) throw new Error('Alias UI: ' + label); await new Promise(resolve => setTimeout(resolve, 30)); } }
  /** 표시 텍스트가 일치하는 버튼을 찾는다. */
  function button(text, root = document) { return [...root.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
  /** 사용할 수 있는 버튼만 누른다. */
  function click(text, root = document) { const node = button(text, root); if (!node || node.disabled) throw new Error('Alias button unavailable: ' + text); node.click(); }
  /** 실제 React 입력 이벤트를 발생시킨다. */
  async function fill(id, value) { const node = document.getElementById(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 35)); }
  /** 조건 불일치의 의미를 검증 결과에 남긴다. */
  function check(value, message) { if (!value) throw new Error(message); }
  /** 화면에 있는 Character Alias 영역만 찾는다. */
  function manager() { return document.querySelector('[aria-label="별칭 관리"]'); }
  /** Character 목록 버튼을 눌러 폼 hydrate 완료까지 기다린다. */
  async function open(name) { click(name, document.querySelector('.canon-record-list')); await waitFor(() => document.getElementById('canon-record-name')?.value === name && manager(), 'Character ' + name); }
  /** Alias 추가 후 실제 목록과 쓰기 잠금 해제를 확인한다. */
  async function add(text) { await fill('character-alias-text', text); click('별칭 추가', manager()); await waitFor(() => [...manager().querySelectorAll('li span')].some(node => node.textContent === text) && !manager().querySelector('fieldset').disabled, 'Alias added ' + text); }
  window.confirm = () => true;
  click('설정'); await waitFor(() => document.querySelector('h1')?.textContent === '애플리케이션 설정', 'leave');
  click(mode === 'preview' ? '작품/회차' : '컨셉정리');
  await waitFor(() => [...document.querySelectorAll('.work-card-button')].some(node => node.textContent.includes('별칭 UI 작품') && !node.textContent.includes('다른 별칭')), 'work list');
  [...document.querySelectorAll('.work-card-button')].find(node => node.textContent.includes('별칭 UI 작품') && !node.textContent.includes('다른 별칭')).click();
  if (mode === 'preview') {
    await waitFor(() => document.querySelector('.viewer-episode-button'), 'Episode'); document.querySelector('.viewer-episode-button').click();
    await waitFor(() => document.getElementById('episode-content') && !button('작업 컨텍스트 확인').disabled, 'Manuscript');
    click('작업 컨텍스트 확인'); await waitFor(() => document.querySelector('[aria-label="검토 컨텍스트 미리보기"]'), 'Alias preview');
    const preview = document.querySelector('[aria-label="검토 컨텍스트 미리보기"]');
    check(preview.textContent.includes('공통호칭') && preview.textContent.includes('모호함'), 'Alias ambiguity missing');
    check(preview.textContent.includes('한지수 — 제1기사단') && preview.textContent.includes('이카로스 — 제2기사단'), 'Candidate organization missing');
    check(preview.textContent.includes('실제 지시 대상은 아직 확정되지'), 'Candidate uncertainty missing');
    click('검토부에 제출'); await waitFor(() => document.querySelector('[aria-label="검토"]')?.textContent.includes('제출 상태: 완료'), 'Stub completed');
    await waitFor(() => document.body.textContent.includes('실제 원고 검토는 아직 수행되지 않았습니다.'), 'Stub history loaded');
    check(document.body.textContent.includes('실제 원고 검토는 아직 수행되지 않았습니다.'), 'Stub disclaimer missing');
    return { ambiguousPreview: true };
  }
  await waitFor(() => document.querySelector('[aria-label="설정 분류"]') && !document.querySelector('.back-button').disabled, 'Canon sets');
  const characterButton = [...document.querySelectorAll('[aria-label="설정 분류"] button')].find(node => node.querySelector('span').textContent === '캐릭터'); characterButton.click();
  await waitFor(() => document.querySelector('.canon-record-list h2')?.textContent === '캐릭터' && !document.querySelector('.back-button').disabled, 'Characters');
  await open('한지수');
  if (mode === 'race' || mode === 'work-race') {
    await waitFor(() => manager().textContent.includes('불러오는 중'), 'Delayed aliases');
    if (mode === 'race') await open('이카로스');
    else {
      click('← 작품 선택'); await waitFor(() => button('다른 별칭 UI 작품'), 'Other Work'); click('다른 별칭 UI 작품');
      await waitFor(() => document.querySelector('[aria-label="설정 분류"]') && !document.querySelector('.back-button').disabled, 'Other Canon');
      [...document.querySelectorAll('[aria-label="설정 분류"] button')].find(node => node.querySelector('span').textContent === '캐릭터').click();
      await waitFor(() => document.querySelector('.canon-record-list h2')?.textContent === '캐릭터' && !document.querySelector('.back-button').disabled, 'Other Characters'); await open('한지수');
    }
    await waitFor(() => !manager().querySelector('fieldset').disabled, 'Latest aliases'); await new Promise(resolve => setTimeout(resolve, 700));
    check(!manager().textContent.includes('A 전용'), 'Old Character aliases leaked');
    check(manager().textContent.includes(mode === 'race' ? '공통호칭' : '다른 작품별칭'), 'Current aliases missing');
    return { staleAliasIgnored: true, mode };
  }
  await waitFor(() => !manager().querySelector('fieldset').disabled, 'Loaded aliases');
  await add('공통호칭'); await add('A 전용');
  await fill('character-alias-text', '공통호칭'); click('별칭 추가', manager());
  await waitFor(() => manager().querySelector('[role="alert"]')?.textContent.includes('이미 등록'), 'Duplicate Korean message');
  click('별칭 입력 취소', manager());
  const row = [...manager().querySelectorAll('li')].find(node => node.querySelector('span').textContent === 'A 전용'); click('수정', row);
  await fill('character-alias-text', '수정 별칭'); click('별칭 수정 저장', manager());
  await waitFor(() => manager().textContent.includes('수정 별칭') && !manager().querySelector('fieldset').disabled, 'Alias updated');
  const updatedRow = [...manager().querySelectorAll('li')].find(node => node.querySelector('span').textContent === '수정 별칭'); click('삭제', updatedRow);
  await waitFor(() => !manager().textContent.includes('수정 별칭') && !manager().querySelector('fieldset').disabled, 'Alias deleted');
  check(document.getElementById('canon-record-name').value === '한지수', 'Alias deletion removed Character');
  await fill('canon-record-name', '미저장 Character draft'); await add('A 전용');
  check(document.getElementById('canon-record-name').value === '미저장 Character draft', 'Alias write erased Character draft');
  window.confirm = () => false; click('이카로스', document.querySelector('.canon-record-list')); check(document.getElementById('canon-record-name').value === '미저장 Character draft', 'Dirty draft navigation escaped');
  await fill('canon-record-name', '한지수'); window.confirm = () => true; await open('이카로스'); await waitFor(() => !manager().querySelector('fieldset').disabled, 'Second aliases');
  await add('공통호칭'); check(!manager().textContent.includes('A 전용'), 'Character alias mixed');
  click('+ 새 항목'); await waitFor(() => document.getElementById('canon-record-name')?.value === '', 'New Character');
  check(!manager(), 'Unsaved Character exposed Alias CRUD');
  return { crud: true, duplicatePolicy: true, draftPreserved: true };
}
module.exports = { exerciseAliases };
