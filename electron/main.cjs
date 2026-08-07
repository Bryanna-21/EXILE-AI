const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

let apiProc = null;

/** Boots the bundled EXILE local API server (local/server.mjs) inside Electron's Node. */
function startLocalApi() {
  const serverPath = path.join(__dirname, "..", "local", "server.mjs");
  if (!fs.existsSync(serverPath)) return;
  try {
    apiProc = spawn(process.execPath, [serverPath], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", EXILE_PORT: process.env.EXILE_PORT || "8787" },
      stdio: "ignore",
      windowsHide: true,
    });
    apiProc.on("error", () => { apiProc = null; });
  } catch {
    apiProc = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#03070d",
    autoHideMenuBar: true,
    title: "EXILE",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  startLocalApi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (apiProc) { try { apiProc.kill(); } catch { /* noop */ } }
  if (process.platform !== "darwin") app.quit();
});
