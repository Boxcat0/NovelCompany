/** 실제 Renderer에서 Canon 시작/취소/중복 클릭/삭제 보호와 기존 Record 편집을 검증한다. */
async function exerciseCanonStart(reopened = false) {
  /** React와 IPC 처리가 끝난 DOM 상태를 제한 시간 내 기다린다. */
  async function waitFor(predicate, label) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Canon UI wait failed: " + label);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  /** 표시 문구가 일치하는 실제 버튼을 찾는다. */
  function button(text) { return [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); }
  /** 활성 버튼의 사용자 클릭을 실행한다. */
  function click(text) { const target = button(text); if (!target || target.disabled) throw new Error("Unavailable: " + text); target.click(); }
  /** 검증 실패에 의미 있는 문맥을 남긴다. */
  function check(value, label) { if (!value) throw new Error(label); }
  /** React 입력 추적을 통해 실제 폼 값을 바꾼다. */
  function fill(id, value) {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** 컨셉정리에서 작품 목록을 읽고 지정 작품을 선택한다. */
  async function selectConcept(title) {
    click("컨셉정리");
    await waitFor(() => button(title) && !button(title).disabled, "work list");
    click(title);
    await waitFor(() => document.querySelector(".back-button") && !document.querySelector(".back-button").disabled, "space loaded");
  }
  /** 실제 작품 관리에서 선택한 작품의 삭제 가능 여부를 확인한다. */
  async function checkDeletion(blocked) {
    click("작품 관리");
    await waitFor(() => button("+ 새 작품") && !button("+ 새 작품").disabled, "management loaded");
    [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("Canon 시작 UI 작품")).click();
    await waitFor(() => document.getElementById("work-title")?.value === "Canon 시작 UI 작품" && !button("+ 새 작품").disabled, "deletion status");
    check(button("삭제").disabled === blocked, "Deletion state mismatch");
  }
  if (reopened) {
    await selectConcept("Canon 시작 UI 작품");
    check(document.body.textContent.includes("아직 등록된 Canon Set이 없습니다."), "Persisted empty space");
    check(!button("Canon 시작"), "Start hidden after reopen");
    if (reopened !== "empty") await checkDeletion(true);
    return { reopened: true };
  }
  let confirmations = 0;
  let confirmed = false;
  /** native 확인 응답을 제어하면서 한국어 확인 내용과 중복 여부를 검사한다. */
  window.confirm = (message) => { check(message.includes("Canon") || message.includes("항목"), "Korean confirmation"); confirmations++; return confirmed; };
  click("작품 관리");
  await waitFor(() => button("+ 새 작품") && !button("+ 새 작품").disabled, "initial management");
  click("+ 새 작품");
  await waitFor(() => document.getElementById("work-title")?.value === "", "new work");
  fill("work-title", "Canon 시작 UI 작품");
  click("저장");
  await waitFor(() => document.querySelector(".work-success-message")?.textContent === "저장되었습니다." && !button("+ 새 작품").disabled, "saved work");
  check(!button("삭제").disabled, "Initially deletable");
  await selectConcept("Canon 시작 UI 작품");
  check(Boolean(button("Canon 시작")), "Start missing");
  click("Canon 시작");
  await waitFor(() => button("Canon 시작") && !button("Canon 시작").disabled, "cancelled");
  const work = (await window.novelCompany.works.getAll()).data.find((item) => item.title === "Canon 시작 UI 작품");
  check((await window.novelCompany.canon.spaces.getByWorkId(work.id)).data === null, "Cancel wrote space");
  confirmed = true;
  const start = button("Canon 시작");
  start.click(); start.click();
  // 같은 이벤트 턴의 Sidebar 이동도 동기 ref 보호로 차단되어야 한다.
  click("작품 관리");
  check(document.querySelector("h1").textContent === "컨셉정리", "Pending navigation escaped");
  await waitFor(() => document.body.textContent.includes("Canon이 시작되었습니다."), "started");
  check(confirmations === 2, "Duplicate click confirmation");
  check(!button("Canon 시작"), "Start remained after success");
  check(document.body.textContent.includes("아직 등록된 Canon Set이 없습니다."), "Empty sets missing");
  const space = (await window.novelCompany.canon.spaces.getByWorkId(work.id)).data;
  check((await window.novelCompany.canon.sets.getByCanonSpaceId(space.id)).data.length === 0, "Unexpected seed");
  await checkDeletion(true);
  await selectConcept("임시 검증 작품");
  check(!button("Canon 시작"), "Existing Canon offered start");
  check(document.querySelectorAll("nav[aria-label='설정 분류'] button").length === 11, "Existing sets lost");
  [...document.querySelectorAll("nav[aria-label='설정 분류'] button")].find((item) => item.querySelector("span").textContent === "캐릭터").click();
  await waitFor(() => document.querySelector("h2")?.textContent === "캐릭터" && [...document.querySelectorAll("nav[aria-label='설정 분류'] button")].every((item) => !item.disabled), "character readiness");
  check(button("+ 새 항목").disabled, "Required references lost");
  [...document.querySelectorAll("nav[aria-label='설정 분류'] button")].find((item) => item.querySelector("span").textContent === "세계").click();
  await waitFor(() => button("+ 새 항목") && !button("+ 새 항목").disabled, "world ready");
  document.querySelector(".canon-definition summary").click();
  check(document.querySelector(".canon-definition").open, "Definition unavailable");
  click("+ 새 항목");
  await waitFor(() => document.getElementById("canon-record-name"), "dynamic form");
  fill("canon-record-name", "UI 세계"); click("저장");
  await waitFor(() => button("UI 세계") && button("삭제") && !button("삭제").disabled, "record created");
  fill("canon-record-name", "UI 세계 수정"); click("저장");
  await waitFor(() => button("UI 세계 수정") && !button("삭제").disabled, "record updated");
  click("삭제");
  await waitFor(() => !button("UI 세계 수정") && !document.getElementById("canon-record-name"), "record deleted");
  return { confirmations, checks: "Canon cancel/create/double-click/navigation/empty/deletion guard; existing definition/readiness/Record CRUD" };
}

module.exports = { exerciseCanonStart };
