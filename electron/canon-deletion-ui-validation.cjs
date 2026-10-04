/** 실제 Renderer에서 삭제 확인 단계, dirty 보호, 재시작 및 Work 삭제 상태 복원을 검사한다. */
async function exerciseCanonDeletion(restarted = false) {
  const confirmations = [];
  let answers = [];
  /** React 갱신과 IPC 완료를 기다리고 제한 시간 초과 시 해당 시나리오를 실패시킨다. */
  async function waitFor(predicate, label) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Canon deletion UI wait failed: " + label);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  /** 표시된 문구로 버튼을 찾아 실제 사용자 조작 대상으로 반환한다. */
  function button(text) { return [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); }
  /** 비활성 버튼을 누르는 테스트 오류 없이 실제 click을 발생시킨다. */
  function click(text) { const item = button(text); if (!item || item.disabled) throw new Error("Unavailable: " + text); item.click(); }
  /** 검증 실패 이유를 Main에 전달한다. */
  function check(value, message) { if (!value) throw new Error(message); }
  /** 예상한 확인 순서를 소비하고 영향 확인 시 요청 중 화면 잠금도 검사한다. */
  window.confirm = (message) => {
    confirmations.push(message);
    check(answers.length > 0, "Unexpected confirmation: " + message);
    if (message.includes("Canon Set:") || message.includes("현재 등록된 Canon 설정 데이터")) {
      check(button("Canon 전체 삭제").disabled, "Delete must be disabled during impact confirmation");
      check(document.body.textContent.includes("Canon 삭제 정보를 확인하거나 삭제하는 중입니다."), "Loading missing");
    }
    return answers.shift();
  };
  /** 작품 관리를 경유해 컨셉정리 목록을 다시 읽고 대상 작품을 선택한다. */
  async function selectCanon(title) {
    click("작품 관리");
    await waitFor(() => button("+ 새 작품") && !button("+ 새 작품").disabled, "management ready");
    click("컨셉정리");
    await waitFor(() => button(title) && !button(title).disabled, "concept list");
    click(title);
    await waitFor(() => document.querySelector(".back-button") && !document.querySelector(".back-button").disabled, "canon loaded");
  }
  /** UI 성공과 모든 오래된 Definition/Record/폼 제거를 함께 검사한다. */
  async function deleted() {
    await waitFor(() => button("Canon 시작") && !button("Canon 시작").disabled, "back to no Canon");
    check(document.body.textContent.includes("Canon이 삭제되었습니다."), "Success missing");
    check(!button("Canon 전체 삭제"), "Delete action remained");
    check(!document.querySelector(".canon-manager, .canon-form, .canon-definition"), "Stale Canon UI remained");
    check(answers.length === 0, "Missing confirmation step");
  }
  /** 작품 관리 재진입 후 최신 hasCanonSpace와 Episode 기반 삭제 상태가 반영되는지 검사한다. */
  async function deletionStatus(title, blocked) {
    click("작품 관리");
    await waitFor(() => button("+ 새 작품") && !button("+ 새 작품").disabled, "work list");
    [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes(title)).click();
    await waitFor(() => document.getElementById("work-title")?.value === title && !button("+ 새 작품").disabled, "work status");
    check(button("삭제").disabled === blocked, "Work deletion state mismatch");
    check(document.querySelector(".work-deletion-status").textContent.includes("Canon 데이터: 없음"), "Canon status stale");
  }
  const works = (await window.novelCompany.works.getAll()).data;
  const empty = works.find((item) => item.title === "삭제 빈 Canon");
  const populated = works.find((item) => item.title === "삭제 데이터 Canon");
  const episodeWork = works.find((item) => item.title === "삭제 회차 Canon");
  if (restarted === "failure") {
    await selectCanon(empty.title);
    answers = [true]; click("Canon 전체 삭제");
    await waitFor(() => document.querySelector("[role=alert]")?.textContent === "Canon을 삭제하는 중 오류가 발생했습니다." && !button("Canon 전체 삭제").disabled, "delete failure recovery");
    check(!button("Canon 시작"), "Failed delete cleared Canon");
    check((await window.novelCompany.canon.spaces.getByWorkId(empty.id)).data !== null, "Failed delete removed data");
    return { failedDeletePreserved: true };
  }
  if (restarted) {
    for (const work of [empty, populated, episodeWork]) check((await window.novelCompany.canon.spaces.getByWorkId(work.id)).data === null, "Deleted Canon returned after restart");
    await selectCanon(empty.title);
    check(button("Canon 시작") && !button("Canon 전체 삭제"), "Restart state incorrect");
    answers = [true]; click("Canon 시작");
    await waitFor(() => button("Canon 전체 삭제") && !button("Canon 전체 삭제").disabled, "restart Canon");
    check(document.body.textContent.includes("아직 등록된 Canon Set이 없습니다."), "Restart seeded data");
    answers = [true]; click("Canon 전체 삭제"); await deleted();
    return { restarted: true, checks: "deleted Canon stays absent; restart creates fresh empty space" };
  }
  await selectCanon(empty.title);
  const emptySpaceId = (await window.novelCompany.canon.spaces.getByWorkId(empty.id)).data.id;
  answers = [false]; click("Canon 전체 삭제");
  await waitFor(() => !button("Canon 전체 삭제").disabled, "empty cancel");
  check(confirmations.at(-1).includes("현재 등록된 Canon 설정 데이터는 없습니다."), "Empty warning missing");
  check((await window.novelCompany.canon.spaces.getByWorkId(empty.id)).data.id === emptySpaceId, "Cancel deleted space");
  answers = [true];
  const beforeDouble = confirmations.length;
  const deleteButton = button("Canon 전체 삭제"); deleteButton.click(); deleteButton.click();
  click("작품 관리");
  check(document.querySelector("h1").textContent === "컨셉정리", "Pending navigation escaped");
  await deleted();
  check(confirmations.length === beforeDouble + 1, "Duplicate delete was not blocked");
  await deletionStatus(empty.title, false);

  await selectCanon(populated.title);
  const initial = (await window.novelCompany.canon.spaces.getDeletionStatus(populated.id)).data;
  [...document.querySelectorAll("nav[aria-label='설정 분류'] button")].find((item) => item.querySelector("span").textContent === "세계").click();
  await waitFor(() => button("삭제 검증 세계") && !button("삭제 검증 세계").disabled, "record list");
  click("삭제 검증 세계");
  await waitFor(() => document.getElementById("canon-record-name") && !button("삭제").disabled, "record form");
  const name = document.getElementById("canon-record-name");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(name, "미저장 수정");
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => document.body.textContent.includes("저장하지 않은 변경사항"), "dirty");
  answers = [false]; click("Canon 전체 삭제");
  check(confirmations.at(-1).includes("변경 내용을 버리고 Canon 전체 삭제"), "Dirty warning missing");
  check(name.value === "미저장 수정", "Dirty cancel lost input");
  answers = [true, false]; click("Canon 전체 삭제");
  await waitFor(() => !button("Canon 전체 삭제").disabled, "impact cancel");
  check(confirmations.at(-1).includes("Canon Set: 11개") && confirmations.at(-1).includes("Canon Field: 31개") && confirmations.at(-1).includes("Canon Record: 3개") && confirmations.at(-1).includes("기타 연결·기존 Canon 데이터: 22행"), "Impact counts incorrect");
  answers = [true, true, false]; click("Canon 전체 삭제");
  await waitFor(() => !button("Canon 전체 삭제").disabled, "final cancel");
  check(confirmations.at(-1).includes("삭제 후 복구할 수 없습니다."), "Strong confirmation missing");
  check(JSON.stringify((await window.novelCompany.canon.spaces.getDeletionStatus(populated.id)).data) === JSON.stringify(initial), "Cancel changed persisted Canon");
  answers = [true, true, true]; click("Canon 전체 삭제"); await deleted();
  check(document.querySelector(".section-label").textContent === populated.title, "Selected Work lost");
  await deletionStatus(populated.title, false);

  await selectCanon(episodeWork.title);
  const episodesBefore = (await window.novelCompany.episodes.getByWorkId(episodeWork.id)).data;
  const textBefore = (await window.novelCompany.episodes.readContent(episodesBefore[0].id)).data;
  answers = [true]; click("Canon 전체 삭제"); await deleted();
  check(JSON.stringify((await window.novelCompany.episodes.getByWorkId(episodeWork.id)).data) === JSON.stringify(episodesBefore), "Episode changed");
  check((await window.novelCompany.episodes.readContent(episodesBefore[0].id)).data === textBefore, "TXT changed");
  await deletionStatus(episodeWork.title, true);
  check(document.querySelector(".work-deletion-status").textContent.includes("회차가 있어"), "Episode blocker reason missing");
  await selectCanon(populated.title);
  check(button("Canon 시작") && !button("Canon 전체 삭제"), "Final no-Canon state missing");
  return { confirmations: confirmations.length, checks: "empty/mixed deletion, all cancel stages, dirty input, loading/duplicate/navigation guard, stale state reset, Episode/TXT preservation, Work deletion restoration" };
}

module.exports = { exerciseCanonDeletion };
