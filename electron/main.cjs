const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const { closeDatabase, initializeDatabase } = require("./database/database.cjs");
const { registerEpisodeHandlers } = require("./ipc/episode-handlers.cjs");
const { registerCanonHandlers } = require("./ipc/canon-handlers.cjs");
const { registerContextHandlers } = require("./ipc/context-handlers.cjs");
const { registerReviewHandlers } = require("./ipc/review-handlers.cjs");
const { createReviewQueue } = require('./review/review-queue-service.cjs');
const { registerWorkHandlers } = require("./ipc/work-handlers.cjs");
const { LocalEpisodeStorage } = require("./storage/local-episode-storage.cjs");
const { getDataRoot } = require('./storage/storage-paths.cjs');
const { recoverInterruptedRestore } = require('./backup/data-backup-service.cjs');
const { registerBackupHandlers } = require('./ipc/backup-handlers.cjs');
const { getOperationStatus } = require('./backup/data-operation-gate.cjs');

const isDevelopment = !app.isPackaged;
const episodeStorage = new LocalEpisodeStorage();
const reviewQueue = createReviewQueue(episodeStorage);
const primaryInstance = app.requestSingleInstanceLock();

/**
 * Renderer 보안 설정과 preload bridge를 포함한 애플리케이션 창을 만든다.
 */
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  /** native dialog 대기 중에도 데이터 작업이 끝날 때까지 창 종료를 막는다. */
  mainWindow.on('close', event => { if (getOperationStatus().busy) event.preventDefault(); });

  if (isDevelopment) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

/**
 * 앱이 활성화될 때 열려 있는 창이 없으면 새 창을 복원한다.
 */
function createWindowOnActivate() {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}

/**
 * Windows와 Linux에서 마지막 창이 닫히면 애플리케이션을 종료한다.
 */
function quitOnWindowClosed() {
  if (process.platform !== "darwin") {
    app.quit();
  }
}

/**
 * 백업·복원 및 native dialog가 끝날 때까지 앱 종료 요청을 막는다.
 */
function protectDataOperationOnQuit(event) {
  if (getOperationStatus().busy) event.preventDefault();
}

/** Renderer의 종료 취소가 끝난 실제 종료 단계에서만 Worker와 SQLite 연결을 닫는다. */
function closeDatabaseOnQuit() {
  reviewQueue.stop();
  closeDatabase();
}

/**
 * 미완료 복원을 먼저 복구한 뒤 DB·Worker·보안 IPC와 Renderer를 시작한다.
 */
async function startApplication() {
  try {
    recoverInterruptedRestore(getDataRoot());
    await episodeStorage.ensureBaseStorage();
    initializeDatabase();
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain, { dialog });
    registerEpisodeHandlers(ipcMain, episodeStorage);
    registerContextHandlers(ipcMain, episodeStorage);
    registerReviewHandlers(ipcMain, episodeStorage, reviewQueue);
    registerBackupHandlers(ipcMain, {
      dialog, queue: reviewQueue, applicationVersion: app.getVersion(),
      /** 열린 DB를 교체한 뒤 모든 Repository·Worker를 새 프로세스에서 시작한다. */
      onRestored: () => { app.relaunch(); setTimeout(() => app.exit(0), 300); },
      /** 원본 복구에 실패하면 닫힌 DB로 후속 작업을 받지 않고 앱을 종료한다. */
      onFatal: () => { dialog.showErrorBox('데이터 복구 필요', '원본 복구 파일을 보존했습니다. 프로그램을 종료하고 다시 시작해 주세요.'); app.exit(1); },
    });
  } catch (error) {
    console.error("로컬 데이터 또는 검토 대기열을 초기화하지 못했습니다.", error);
    dialog.showErrorBox('로컬 데이터 시작 실패', '검토 대기열 또는 로컬 데이터를 복구하지 못했습니다. 오류를 확인한 뒤 다시 시작해 주세요.');
    app.quit();
    return;
  }

  createWindow();
  app.on("activate", createWindowOnActivate);
}

/** 같은 앱의 두 Main 프로세스가 서로의 백업 잠금을 우회하지 않도록 단일 인스턴스를 유지한다. */
app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
if (primaryInstance) app.whenReady().then(startApplication);
else app.quit();
app.on("window-all-closed", quitOnWindowClosed);
app.on("before-quit", protectDataOperationOnQuit);
app.on("will-quit", closeDatabaseOnQuit);
