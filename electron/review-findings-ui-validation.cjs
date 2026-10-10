/** sandbox Renderer의 저장 근거·응답 경합과 운영 Mock 선택 거부를 검증한다. */
async function exerciseFindings(runId, mode = 'normal') {
  /** React 및 IPC 응답을 제한 시간 동안 기다린다. */
  async function waitFor(check, label) { const deadline = Date.now() + 10000; await new Promise(resolve => setTimeout(resolve, 40)); while (!check()) { if (Date.now() > deadline) throw new Error('Findings UI: ' + label); await new Promise(resolve => setTimeout(resolve, 25)); } }
  /** 실제 표시 문구가 같은 버튼을 찾는다. */
  function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
  /** 회차 번호로 선택 버튼을 찾는다. */
  function episode(number) { return [...document.querySelectorAll('.viewer-episode-button')].find(node => node.querySelector('.viewer-episode-number').textContent === `${number}화`); }
  /** 조건 실패를 의미 있는 오류로 전달한다. */
  function check(value, message) { if (!value) throw new Error(message); }
  if (mode === 'normal') {
    button('설정').click(); await waitFor(() => document.querySelector('h1')?.textContent === '애플리케이션 설정', 'leave');
    button('작품/회차').click();
    await waitFor(() => [...document.querySelectorAll('.work-card-button')].some(node => node.textContent.includes('Task029 가상 작품')), 'work');
    [...document.querySelectorAll('.work-card-button')].find(node => node.textContent.includes('Task029 가상 작품')).click();
    await waitFor(() => episode(1), 'episode'); episode(1).click();
    await waitFor(() => document.querySelector(`[data-review-run-id="${runId}"]`), 'result');
    const run = document.querySelector(`[data-review-run-id="${runId}"]`);
    run.querySelector('summary').click();
    check(run.querySelector('details').open, 'Finding details do not open');
    const text = run.textContent;
    for (const required of ['REVIEW_FINDINGS_V1', 'MOCK_V1', '테스트용 가상 검토 결과', 'Finding 3건', 'ERROR', 'INFERENCE_CANDIDATE', 'UNDETERMINED', 'Canon Record 근거 · 원문 범위 없음', '판단 근거', '제1기사단', '제2기사단', '모호한 명칭 후보', '실제 지시 대상 미확정']) check(text.includes(required), 'Missing viewer field: ' + required);
    check(run.querySelector('blockquote').textContent === '😀', 'Historical UTF-16 excerpt mismatch');
    check(run.querySelectorAll('[data-finding-id]').length === 3, 'Finding ordering/count mismatch');
    check(!run.querySelector('img') && !window.findingInjected, 'Unsafe HTML rendering');
    const fetched = await window.novelCompany.reviews.getById(runId);
    check(fetched.ok && fetched.data.findings.length === 3 && fetched.data.findings[0].sortOrder === 0, 'Public detail DTO mismatch');
    const denied = await window.novelCompany.reviews.submit({ workId: fetched.data.workId, episodeId: fetched.data.episodeId, processorKey: 'MOCK_V1' });
    check(!denied.ok && denied.error.code === 'REVIEW_PROCESSOR_INVALID', 'Renderer selected a Mock Processor');
    episode(2).click(); await waitFor(() => document.querySelector('.review-history')?.textContent.includes('STUB_V1'), 'stub');
    check(document.querySelector('.review-history').textContent.includes('실제 원고 검토는 아직 수행되지 않았습니다.'), 'Stub implies actual review');
    check(!/문제 없음|이상 없음|충돌 없음/.test(document.querySelector('.review-history').textContent), 'Stub claims no issues');
    return 'PASS: details/enums/excerpt/Canon/ambiguous organizations/provenance/HTML/Stub';
  }
  if (mode === 'race') {
    episode(1).click(); await waitFor(() => document.getElementById('episode-number')?.value === '1', 'first editor');
    episode(2).click(); await waitFor(() => document.querySelector('.review-history')?.textContent.includes('STUB_V1'), 'second result');
    await new Promise(resolve => setTimeout(resolve, 650));
    check(!document.querySelector(`[data-review-run-id="${runId}"]`) && !document.querySelector('.review-history')?.textContent.includes('MOCK_V1'), 'Late result crossed Episode boundary');
    return 'PASS: delayed Episode history discarded';
  }
  episode(1).click(); await waitFor(() => document.querySelector(`[data-review-run-id="${runId}"]`), 'historical result');
  const run = document.querySelector(`[data-review-run-id="${runId}"]`);
  check(run.textContent.includes('현재 입력을 읽을 수 없어') && run.querySelector('blockquote').textContent === '😀' && run.textContent.includes('제1기사단'), 'Deleted Canon changed historical evidence');
  return 'PASS: deleted Canon and edited TXT retain historical evidence';
}

module.exports = { exerciseFindings };
