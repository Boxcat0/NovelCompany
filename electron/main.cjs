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

const isDevelopment = !app.isPackaged;
const episodeStorage = new LocalEpisodeStorage();
const reviewQueue = createReviewQueue(episodeStorage);

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
 * 앱 종료 전에 재사용 중인 SQLite 연결을 정상적으로 닫는다.
 */
function closeDatabaseOnQuit() {
  reviewQueue.stop();
  closeDatabase();
}

/**
 * Storage와 DB를 준비한 뒤 IPC Handler를 등록하고 Renderer 창을 연다.
 */
async function startApplication() {
  try {
    await episodeStorage.ensureBaseStorage();
    initializeDatabase();
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain);
    registerEpisodeHandlers(ipcMain, episodeStorage);
    registerContextHandlers(ipcMain, episodeStorage);
    registerReviewHandlers(ipcMain, episodeStorage, reviewQueue);
  } catch (error) {
    console.error("로컬 데이터 또는 검토 대기열을 초기화하지 못했습니다.", error);
    dialog.showErrorBox('로컬 데이터 시작 실패', '검토 대기열 또는 로컬 데이터를 복구하지 못했습니다. 오류를 확인한 뒤 다시 시작해 주세요.');
    app.quit();
    return;
  }

  createWindow();
  app.on("activate", createWindowOnActivate);
}

app.whenReady().then(startApplication);
app.on("window-all-closed", quitOnWindowClosed);
app.on("before-quit", closeDatabaseOnQuit);
