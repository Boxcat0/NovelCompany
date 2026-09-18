const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { LocalEpisodeStorage } = require("./storage/local-episode-storage.cjs");

const isDevelopment = !app.isPackaged;
const episodeStorage = new LocalEpisodeStorage();

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDevelopment) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  try {
    await episodeStorage.ensureBaseStorage();
  } catch (error) {
    console.error("Failed to prepare episode storage.", error);
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
