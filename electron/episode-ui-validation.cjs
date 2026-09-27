/** 실제 sandbox Renderer에서 회차 편집, dirty 보호, 번호 재사용과 재시작 원고를 검증한다. */
async function exerciseEpisodes(mode = "normal") {
  /** React/IPC가 목표 상태를 반영할 때까지 제한 시간 안에서 기다린다. */
  async function waitFor(predicate, label) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Episode UI: " + label); await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  /** 표시 문구로 버튼을 찾아 실제 클릭 대상에 접근한다. */
  function button(text) { return [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); }
  /** 사용할 수 있는 버튼만 클릭해 비활성 상태를 검증한다. */
  function click(text) { const item = button(text); if (!item || item.disabled) throw new Error("Unavailable: " + text); item.click(); }
  /** DOM 값과 React 변경 이벤트를 함께 갱신한다. */
  async function fill(id, value) {
    const element = document.getElementById(id);
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  /** 실패한 검증의 의미를 테스트 결과에 남긴다. */
  function check(value, label) { if (!value) throw new Error(label); }
  /** 번호로 목록 항목을 찾으며 선택 상태와 별개로 실제 버튼을 반환한다. */
  function episode(number) { return [...document.querySelectorAll(".viewer-episode-button")].find((item) => item.querySelector(".viewer-episode-number").textContent === number + "화"); }
  /** 편집 내용을 저장하고 목록 갱신 및 쓰기 잠금 해제를 기다린다. */
  async function save() { const target = button("저장"); target.click(); target.click(); click("작품 관리"); check(document.querySelector("h1").textContent === "작품/회차", "Pending save navigation escaped"); await waitFor(() => document.querySelector(".work-success-message")?.textContent === "저장되었습니다." && !button("저장").disabled, "save"); }
  /** 새 폼에서 추천 번호를 확인한 뒤 빈 원고 회차를 저장한다. */
  async function create(number) { click("+ 새 회차"); await waitFor(() => document.getElementById("episode-number"), "new draft"); check(document.getElementById("episode-number").value === String(number), "Gap suggestion " + number); await fill("episode-title", "UI " + number); await save(); }
  window.confirm = () => true;
  click("설정");
  await waitFor(() => document.querySelector("h1")?.textContent === "애플리케이션 설정", "leave previous screen");
  click("작품/회차");
  await waitFor(() => [...document.querySelectorAll(".work-card-button")].some((item) => item.textContent.includes("회차 UI 작품")), "work list");
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("회차 UI 작품")).click();
  await waitFor(() => button("+ 새 회차") && !button("+ 새 회차").disabled, "episode list");
  if (mode !== "normal") {
    episode(1).click();
    if (mode === "readfailure") {
      await waitFor(() => document.body.textContent.includes("원고를 읽지 못해 저장할 수 없습니다."), "read blocked");
      check(!button("저장"), "Read failure exposed save");
      return { readFailureBlocked: true };
    }
    if (mode === "race") {
      episode(4).click();
      await waitFor(() => document.getElementById("episode-number")?.value === "4", "latest episode");
      await new Promise((resolve) => setTimeout(resolve, 500));
      check(document.getElementById("episode-number").value === "4", "Late A replaced B");
      return { staleReadIgnored: true };
    }
    await waitFor(() => document.getElementById("episode-content"), "loaded manuscript");
    if (mode === "missing") {
      check(document.body.textContent.includes("저장하면 새 원고 파일을 생성"), "Missing recovery hint");
      check(document.body.textContent.includes("저장하지 않은 변경사항"), "Missing must be dirty");
      await save();
      check(!document.body.textContent.includes("저장하면 새 원고 파일을 생성"), "Recovery not cleared");
      await fill("episode-content", "  재시작 원고\n둘째 줄\n"); await save();
      return { missingRecovered: true };
    }
    check(document.getElementById("episode-content").value === "  재시작 원고\n둘째 줄\n", "Restart text differs");
    check([...document.querySelectorAll(".viewer-episode-number")].map((item) => item.textContent).join(",") === "1화,3화,4화,7화", "Restart ordering");
    const work = (await window.novelCompany.works.getAll()).data.find((item) => item.title === "회차 UI 작품");
    check((await window.novelCompany.episodes.getNextAvailableNumber(work.id)).data === 2, "Restart gap");
    return { restartPersistence: true };
  }
  for (const number of [1, 2, 3, 4]) await create(number);
  episode(3).click(); await waitFor(() => document.getElementById("episode-number")?.value === "3", "select 3");
  click("삭제"); await waitFor(() => !episode(3) && !document.getElementById("episode-title") && !button("+ 새 회차").disabled, "delete 3");
  await create(3);
  episode(2).click(); await waitFor(() => document.getElementById("episode-number")?.value === "2", "select 2");
  await fill("episode-number", "7"); await fill("episode-status", "COMPLETED"); await fill("episode-content", "번호 변경 원고"); await save();
  check(!episode(2) && episode(7), "Number update list");
  await fill("episode-number", "1"); click("저장");
  await waitFor(() => document.querySelector("[role=alert]")?.textContent.includes("같은 회차 번호"), "duplicate rejection");
  window.confirm = () => false;
  click("+ 새 회차"); episode(1).click(); click("← 작품 목록"); click("작품 관리"); click("삭제");
  check(document.getElementById("episode-number").value === "1" && document.querySelector("h1").textContent === "작품/회차", "Dirty cancel escaped");
  const closeEvent = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(closeEvent); check(closeEvent.defaultPrevented, "Dirty close unprotected");
  window.confirm = () => true;
  episode(1).click(); await waitFor(() => document.getElementById("episode-number")?.value === "1" && document.getElementById("episode-title")?.value === "UI 1", "discard");
  await fill("episode-content", "  재시작 원고\n둘째 줄\n"); await save();
  check(document.querySelector(".episode-counts").textContent.includes("3줄"), "Line counter");
  return { checks: "empty/create/double-save/update/duplicate/delete/gap/dirty/close/counts" };
}

module.exports = { exerciseEpisodes };
