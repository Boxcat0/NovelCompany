const electron = require("electron");
// Node 진입점은 기존 환경의 ELECTRON_RUN_AS_NODE를 제거한 자식 Electron으로 검증을 실행한다.
if (typeof electron === "string") {
  const { spawnSync } = require("node:child_process");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [__filename], { env: environment, encoding: "utf8", windowsHide: true });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) console.error(result.error);
  if (result.status === 0) {
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    const restart = spawnSync(electron, [__filename, "--canon-restart", report.temporaryRoot], { env: environment, stdio: "inherit", windowsHide: true });
    process.exit(restart.status ?? 1);
  }
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { initializeDatabase, getDatabase, closeDatabase } = require("./database/database.cjs");
const { createWork } = require("./database/repositories/work-repository.cjs");
const { addEmptyCanonSpace } = require("./database/work-management-validation.cjs");
const { registerWorkHandlers } = require("./ipc/work-handlers.cjs");
const { registerCanonHandlers } = require("./ipc/canon-handlers.cjs");
const { registerContextHandlers } = require("./ipc/context-handlers.cjs");
const { registerReviewHandlers } = require("./ipc/review-handlers.cjs");
const { registerEpisodeHandlers } = require("./ipc/episode-handlers.cjs");
const { LocalEpisodeStorage } = require("./storage/local-episode-storage.cjs");

const restartingCanon = process.argv.includes("--canon-restart");
const temporaryRoot = restartingCanon ? process.argv[process.argv.indexOf("--canon-restart") + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "novel-company-task018-ui-"));
const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-company-task018-ui-artifacts-"));
process.env.NOVEL_COMPANY_DATA_DIR = temporaryRoot;
app.setPath("userData", path.join(temporaryRoot, "profile"));

/** 실제 Renderer에서 폼 입력과 이동/삭제 확인을 실행하며 결과를 Main 검증으로 반환한다. */
async function exerciseWorkManagement() {
  const confirmations = [];
  let confirmResult = true;
  // 검증 중 확인창은 응답을 제어하되 표시된 문구와 횟수를 모두 기록한다.
  window.confirm = (message) => { confirmations.push(message); return confirmResult; };
  /** 실제 DOM이 기대 상태로 갱신될 때까지 짧게 기다리며 제한 시간 초과를 실패 처리한다. */
  async function waitFor(predicate, label) {
    // 직전 click/input의 React 갱신이 완료되기 전에 이전 화면을 성공으로 판정하지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("UI wait failed: " + label);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  /** 현재 화면의 표시 문구가 같은 버튼을 찾는다. */
  function button(text) { return [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); }
  /** 비활성 버튼을 누르는 테스트 오류를 방지하며 실제 click 이벤트를 발생시킨다. */
  function click(text) {
    const target = button(text);
    if (!target || target.disabled) throw new Error("Button unavailable: " + text);
    target.click();
  }
  /** React의 값 추적을 거쳐 실제 사용자 입력처럼 input/change 이벤트를 발생시킨다. */
  function fill(id, value) {
    const target = document.getElementById(id);
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }
  /** 작품 요청 완료 후 다음 조작이 가능해졌는지 확인한다. */
  async function idle() { await waitFor(() => button("+ 새 작품") && !button("+ 새 작품").disabled, "idle"); }
  /** 검증 실패에 문맥을 포함한다. */
  function check(condition, message) { if (!condition) throw new Error(message); }

  click("작품 관리");
  await idle();
  const protectedButton = [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 보호 작품"));
  protectedButton.click();
  await waitFor(() => document.getElementById("work-title")?.value === "테스트 보호 작품", "hydrate");
  await idle();
  check(button("삭제").disabled, "CanonSpace must block deletion");
  check(document.querySelector(".work-deletion-status").textContent.includes("Canon 데이터가 있어 삭제할 수 없습니다."), "Blocked reason missing");
  click("+ 새 작품");
  await waitFor(() => document.getElementById("work-title")?.value === "", "new form");
  check(document.getElementById("work-status").value === "ACTIVE", "Default status");
  click("저장");
  await waitFor(() => document.querySelector("[role=alert]")?.textContent.includes("작품 제목"), "required title");
  fill("work-title", "  테스트 작품 A  ");
  fill("work-description", "테스트 설명");
  fill("work-status", "PAUSED");
  click("저장");
  await waitFor(() => document.querySelector(".work-success-message")?.textContent === "저장되었습니다.", "create");
  await idle();
  check(document.getElementById("work-title").value === "테스트 작품 A", "Trimmed title");
  check(document.getElementById("work-status").value === "PAUSED", "Created status");
  check(!button("삭제").disabled, "Empty work deletion allowed");
  check(document.querySelector(".work-card-button.is-selected").textContent.includes("테스트 작품 A"), "Created work selected");
  fill("work-title", "테스트 작품 B");
  fill("work-status", "COMPLETED");
  click("저장");
  await idle();
  await waitFor(() => document.querySelector(".work-card-button.is-selected")?.textContent.includes("테스트 작품 B"), "updated list");
  check(document.getElementById("work-status").value === "COMPLETED", "Updated status");

  const cleanConfirmationCount = confirmations.length;
  click("컨셉정리");
  await waitFor(() => document.querySelector("h1")?.textContent === "컨셉정리" && [...document.querySelectorAll(".work-card-button")].some((item) => item.textContent.includes("테스트 작품 B")), "Concept list refresh");
  check(confirmations.length === cleanConfirmationCount, "Saved form must be clean");
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 작품 B")).click();
  await waitFor(() => document.body.textContent.includes("아직 이 작품의 Canon 설정이 없습니다."), "No automatic Canon");
  click("작품/회차");
  await waitFor(() => document.querySelector("h1")?.textContent === "작품/회차" && [...document.querySelectorAll(".work-card-button")].some((item) => item.textContent.includes("테스트 작품 B")), "Viewer list refresh");
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 작품 B")).click();
  await waitFor(() => document.body.textContent.includes("등록된 에피소드가 없습니다."), "No automatic Episode");
  click("작품 관리");
  await idle();
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 작품 B")).click();
  await waitFor(() => document.getElementById("work-title")?.value === "테스트 작품 B", "reload detail");
  await idle();
  fill("work-title", "저장하지 않은 수정");
  await waitFor(() => document.body.textContent.includes("저장하지 않은 변경사항이 있습니다."), "dirty state");
  confirmResult = false;
  click("+ 새 작품");
  check(document.getElementById("work-title").value === "저장하지 않은 수정", "Dirty new-work cancel");
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 보호 작품")).click();
  check(document.getElementById("work-title").value === "저장하지 않은 수정", "Dirty selection cancel");
  click("컨셉정리");
  check(document.getElementById("work-title").value === "저장하지 않은 수정", "Dirty navigation cancel");
  check(confirmations.slice(-3).every((message) => message.includes("변경 내용을 버리고")), "Dirty confirmation messages");
  confirmResult = true;
  // 같은 작품을 다시 읽어 미저장 입력을 폐기하고 실제 DB 값으로 복원한다.
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 작품 B")).click();
  await waitFor(() => document.getElementById("work-title")?.value === "테스트 작품 B", "discard");
  await idle();
  confirmResult = false;
  click("삭제");
  await idle();
  check(document.getElementById("work-title").value === "테스트 작품 B", "Delete cancel");
  check(confirmations.at(-1).includes("되돌릴 수 없습니다"), "Delete confirmation");
  confirmResult = true;
  click("삭제");
  await waitFor(() => document.querySelector(".work-success-message")?.textContent === "삭제되었습니다.", "delete");
  await idle();
  check(![...document.querySelectorAll(".work-card-button")].some((item) => item.textContent.includes("테스트 작품 B")), "Deleted work removed");
  [...document.querySelectorAll(".work-card-button")].find((item) => item.textContent.includes("테스트 보호 작품")).click();
  await waitFor(() => document.getElementById("work-title")?.value === "테스트 보호 작품", "protected final");
  await idle();
  return { confirmations: confirmations.length, checks: "create/update/delete, dependency reason, dirty cancel/discard, Concept/Viewer refresh" };
}

/** 분리된 DB와 실제 Electron 창에서 Work/Canon lifecycle, 삭제 보호와 재시작을 검증한다. */
async function runValidation() {
  let window;
  let exitCode = 0;
  const timer = setTimeout(() => { console.error("UI validation timeout"); app.exit(1); }, 120000);
  try {
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    if (!restartingCanon) {
      const protectedWork = createWork({ title: "테스트 보호 작품", description: "빈 CanonSpace가 연결된 테스트 작품" });
      addEmptyCanonSpace(protectedWork.id);
    }
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain);
    const episodeStorage = new LocalEpisodeStorage(temporaryRoot);
    registerEpisodeHandlers(ipcMain, episodeStorage);
    registerContextHandlers(ipcMain, episodeStorage);
    registerReviewHandlers(ipcMain, episodeStorage);
    const { exerciseEpisodes } = require("./episode-ui-validation.cjs");
    const { exerciseCanonAuthoring } = require("./canon-authoring-ui-validation.cjs");
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
    await window.loadFile(path.join(__dirname, "../dist/index.html"));
    if (restartingCanon) {
      const { exerciseCanonStart } = require("./canon-start-ui-validation.cjs");
      await window.webContents.executeJavaScript("(" + exerciseCanonStart.toString() + ")(true)");
      const { exerciseCanonDeletion } = require("./canon-deletion-ui-validation.cjs");
      await window.webContents.executeJavaScript("(" + exerciseCanonDeletion.toString() + ")(true)");
      await window.webContents.executeJavaScript("(" + exerciseEpisodes.toString() + ")('restart')");
      await window.webContents.executeJavaScript("(" + exerciseCanonAuthoring.toString() + ")('restart')");
      console.log(JSON.stringify({ result: "PASS", persistence: "new Electron process, same temporary DB and profile" }));
      return;
    }
    const result = await window.webContents.executeJavaScript("(" + exerciseWorkManagement.toString() + ")()");
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM works").get().count, 1);
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM episodes").get().count, 0);
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM canon_spaces").get().count, 1);
    const screenshotPath = path.join(artifactsRoot, "work-management.png");
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const { exerciseCanonStart } = require("./canon-start-ui-validation.cjs");
    require("./database/canon-record-validation.cjs").createCanonFixture();
    const canonResult = await window.webContents.executeJavaScript("(" + exerciseCanonStart.toString() + ")()");
    const canonSpaceId = getDatabase().prepare("SELECT cs.id FROM canon_spaces cs JOIN works w ON w.id = cs.work_id WHERE w.title = ?").get("Canon 시작 UI 작품").id;
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM canon_sets WHERE canon_space_id = ?").get(canonSpaceId).count, 0);
    closeDatabase();
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    await window.loadFile(path.join(__dirname, "../dist/index.html"));
    await window.webContents.executeJavaScript("(" + exerciseCanonStart.toString() + ")(true)");
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM canon_records").get().count, 0);
    assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
    const canonScreenshotPath = path.join(artifactsRoot, "canon-deletion-guard.png");
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(canonScreenshotPath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("(" + exerciseCanonStart.toString() + ")('empty')");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const emptyScreenshotPath = path.join(artifactsRoot, "canon-empty.png");
    fs.writeFileSync(emptyScreenshotPath, (await window.webContents.capturePage()).toPNG());
    const { createDeletionFixture } = require("./database/canon-deletion-validation.cjs");
    createDeletionFixture({ generic: false, legacy: false, title: "삭제 빈 Canon" });
    createDeletionFixture({ title: "삭제 데이터 Canon" });
    const episodeFixture = createDeletionFixture({ generic: false, legacy: false, title: "삭제 회차 Canon" });
    const storage = new LocalEpisodeStorage(temporaryRoot);
    await storage.saveEpisode(episodeFixture.workId, 1, "삭제 후에도 유지할 원고");
    require("./database/repositories/episode-repository.cjs").createEpisode({ workId: episodeFixture.workId, episodeNumber: 1, title: "보존할 회차", storageKey: episodeFixture.workId + "/episodes/001.txt" });
    const { exerciseCanonDeletion } = require("./canon-deletion-ui-validation.cjs");
    getDatabase().exec("CREATE TEMP TRIGGER fail_ui_canon_delete AFTER DELETE ON canon_spaces BEGIN SELECT RAISE(FAIL, 'private UI delete failure'); END");
    try { await window.webContents.executeJavaScript("(" + exerciseCanonDeletion.toString() + ")('failure')"); }
    finally { getDatabase().exec("DROP TRIGGER fail_ui_canon_delete"); }
    const deletionResult = await window.webContents.executeJavaScript("(" + exerciseCanonDeletion.toString() + ")()");
    assert.equal(await storage.readEpisode(episodeFixture.workId, 1), "삭제 후에도 유지할 원고");
    assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deletionScreenshotPath = path.join(artifactsRoot, "canon-deleted.png");
    fs.writeFileSync(deletionScreenshotPath, (await window.webContents.capturePage()).toPNG());
    createWork({ title: "회차 UI 작품" });
    const episodeResult = await window.webContents.executeJavaScript("(" + exerciseEpisodes.toString() + ")()");
    const episodeWork = getDatabase().prepare("SELECT id FROM works WHERE title = ?").get("회차 UI 작품");
    const firstKey = episodeWork.id + "/episodes/001.txt";
    fs.unlinkSync(path.join(temporaryRoot, "works", firstKey));
    await window.webContents.executeJavaScript("(" + exerciseEpisodes.toString() + ")(\"missing\")");
    const originalRead = episodeStorage.readEpisodeByStorageKey.bind(episodeStorage);
    /** 누락과 구별해야 하는 일반 읽기 실패를 실제 Main 저장소에 주입한다. */
    episodeStorage.readEpisodeByStorageKey = async () => { throw Object.assign(new Error("private forced read failure"), { code: "EACCES" }); };
    await window.webContents.executeJavaScript("(" + exerciseEpisodes.toString() + ")(\"readfailure\")");
    /** 첫 원고 응답만 늦춰 다른 회차의 최신 응답이 유지되는지 검증한다. */
    episodeStorage.readEpisodeByStorageKey = async (key) => { if (key === firstKey) await new Promise((resolve) => setTimeout(resolve, 300)); return originalRead(key); };
    await window.webContents.executeJavaScript("(" + exerciseEpisodes.toString() + ")(\"race\")");
    episodeStorage.readEpisodeByStorageKey = originalRead;
    const reviewContextChannel = 'context:get-episode-review-context';
    ipcMain.removeHandler(reviewContextChannel);
    /** ReviewContext 응답을 지연시켜 회차 전환 후 이전 결과가 화면을 덮지 않는지 확인한다. */
    ipcMain.handle(reviewContextChannel, (_event, input) => require('./ipc/ipc-action.cjs').executeIpcAction(reviewContextChannel, async () => {
      const context = await require('./context/review-context-builder.cjs').buildEpisodeReviewContext(episodeStorage, input);
      await new Promise(resolve => setTimeout(resolve, 500));
      return context;
    }));
    const contextRaceResult = await window.webContents.executeJavaScript('(' + exerciseEpisodes.toString() + ')("context-race")');
    const episodeScreenshotPath = path.join(artifactsRoot, "episode-editor.png");
    fs.writeFileSync(episodeScreenshotPath, (await window.webContents.capturePage()).toPNG());
    assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
    const { INITIAL_WORK_TITLE } = require("./database/setup/initial-canon-definition.cjs");
    const authorWork = createWork({ title: INITIAL_WORK_TITLE });
    const authorSpace = require("./database/repositories/canon-definition-repository.cjs").createCanonSpaceForWork(authorWork.id);
    require("./database/setup/install-current-work-canon.cjs").installCurrentWorkCanonDefinition(authorSpace.id);
    const authoringResult = await window.webContents.executeJavaScript("(" + exerciseCanonAuthoring.toString() + ")()");
    const authoringScreenshotPath = path.join(artifactsRoot, "canon-authoring.png");
    fs.writeFileSync(authoringScreenshotPath, (await window.webContents.capturePage()).toPNG());
    const definitionRepository = require("./database/repositories/canon-definition-repository.cjs");
    const definitionChannel = "canon:sets:get-definition";
    ipcMain.removeHandler(definitionChannel);
    /** 실제 정의 요청 중 세계 응답만 지연시켜 최신 Set 선택 보호를 확인한다. */
    ipcMain.handle(definitionChannel, (_event, id) => require("./ipc/ipc-action.cjs").executeIpcAction(definitionChannel, async () => {
      const definition = definitionRepository.getCanonDefinitionBySetId(id);
      if (definition?.key === "world") await new Promise((resolve) => setTimeout(resolve, 300));
      return definition;
    }));
    const authoringRaceResult = await window.webContents.executeJavaScript("(" + exerciseCanonAuthoring.toString() + ")('race')");
    const report = { contextRaceResult, authoringResult, authoringRaceResult, authoringScreenshotPath, episodeResult, episodeScreenshotPath, result: "PASS", ...result, canonResult, deletionResult, persistence: "DB connection reopen + Renderer reload", screenshotPath, canonScreenshotPath, emptyScreenshotPath, deletionScreenshotPath, temporaryRoot, database: "isolated temporary DB" };
    fs.writeFileSync(path.join(artifactsRoot, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    exitCode = 1;
    if (window && !window.isDestroyed()) {
      const screenText = await window.webContents.executeJavaScript("document.body.innerText");
      fs.writeFileSync(path.join(artifactsRoot, "failure-screen.txt"), screenText);
      fs.writeFileSync(path.join(artifactsRoot, "failure.png"), (await window.webContents.capturePage()).toPNG());
      console.error(screenText);
    }
    fs.writeFileSync(path.join(artifactsRoot, "result.json"), JSON.stringify({ result: "FAIL", error: error.stack }));
    console.error(error);
  } finally {
    clearTimeout(timer);
    window?.destroy();
    closeDatabase();
    // Electron 프로필은 종료 직전까지 사용될 수 있으므로 임시 디렉터리 삭제는 시도하지 않는다.
    app.exit(exitCode);
  }
}

app.whenReady().then(runValidation);
