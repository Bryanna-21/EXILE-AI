const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const os = require("node:os");

// Keep Chromium's disk and GPU caches in a writable temporary directory.
const exileCacheRoot = path.join(os.tmpdir(), "EXILE-Chromium-Cache");
const exileDiskCache = path.join(exileCacheRoot, "disk");
const exileGpuCache = path.join(exileCacheRoot, "gpu");

for (const dir of [exileDiskCache, exileGpuCache]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.commandLine.appendSwitch("disk-cache-dir", exileDiskCache);
app.commandLine.appendSwitch("gpu-cache-dir", exileGpuCache);

let apiProc = null;
let mainWindow = null;
let companionWindow = null;

function startLocalApi() {
const serverPath = path.join(__dirname, "..", "local", "server.mjs");
if (!fs.existsSync(serverPath)) return;

try {
apiProc = spawn(process.execPath, [serverPath], {
cwd: path.join(__dirname, ".."),
env: {
...process.env,
ELECTRON_RUN_AS_NODE: "1",
EXILE_PORT: process.env.EXILE_PORT || "8787",
},
stdio: "ignore",
windowsHide: true,
});

apiProc.on("error", () => {
  apiProc = null;
});
apiProc.on("exit", () => {
  apiProc = null;
});

} catch {
apiProc = null;
}
}

function configureExternalLinks(win) {
win.webContents.setWindowOpenHandler(({ url }) => {
try {
const parsed = new URL(url);
if (parsed.protocol === "https:" || parsed.protocol === "http:") {
shell.openExternal(url);
}
} catch {
// Ignore malformed or unsupported external URLs.
}
return { action: "deny" };
});
}

function createWindow() {
if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.show();
mainWindow.focus();
return mainWindow;
}

mainWindow = new BrowserWindow({
width: 1280,
height: 860,
backgroundColor: "#03070d",
autoHideMenuBar: true,
title: "EXILE",
webPreferences: {
preload: path.join(__dirname, "preload.cjs"),
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
},
});

mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
configureExternalLinks(mainWindow);
mainWindow.on("closed", () => {
mainWindow = null;
});

return mainWindow;
}

function createCompanionWindow() {
if (companionWindow && !companionWindow.isDestroyed()) {
companionWindow.show();
companionWindow.focus();
return companionWindow;
}

companionWindow = new BrowserWindow({
width: 360,
height: 470,
minWidth: 320,
minHeight: 420,
resizable: true,
frame: false,
transparent: true,
backgroundColor: "#00000000",
alwaysOnTop: true,
skipTaskbar: true,
show: false,
title: "EXILE AI Companion",
webPreferences: {
preload: path.join(__dirname, "preload.cjs"),
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
},
});

companionWindow.loadFile(
path.join(__dirname, "..", "dist", "index.html"),
{ query: { exileWindow: "companion" } },
);

configureExternalLinks(companionWindow);

companionWindow.once("ready-to-show", () => {
if (companionWindow && !companionWindow.isDestroyed()) {
companionWindow.show();
}
});

companionWindow.on("closed", () => {
companionWindow = null;
});

return companionWindow;
}

ipcMain.on("exile:open-dashboard", () => {
createWindow();
});

ipcMain.on("exile:minimize-companion", () => {
if (companionWindow && !companionWindow.isDestroyed()) {
companionWindow.minimize();
}
});

ipcMain.on("exile:close-companion", () => {
if (companionWindow && !companionWindow.isDestroyed()) {
companionWindow.close();
}
});

app.whenReady().then(() => {
startLocalApi();
createWindow();
createCompanionWindow();

app.on("activate", () => {
createWindow();
createCompanionWindow();
});
});

app.on("window-all-closed", () => {
if (apiProc) {
try {
apiProc.kill();
} catch {
// Process may already have exited.
}
apiProc = null;
}

if (process.platform !== "darwin") {
app.quit();
}
});
