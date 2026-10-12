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


ipcMain.handle("exile:venom-synthesize", async (event, text) => {
  // Only the local Electron UI may request speech synthesis.
  if (!event.senderFrame?.url?.startsWith("file://")) return null;
  if (typeof text !== "string" || !text.trim() || text.length > 3000) {
    return null;
  }

  const outputPath = path.join(
    os.tmpdir(),
    `exile-venom-${process.pid}-${Date.now()}.wav`,
  );
  const textBase64 = Buffer.from(text, "utf8").toString("base64");
  const pathBase64 = Buffer.from(outputPath, "utf8").toString("base64");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textBase64}'))`,
    `$outPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))`,
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try {",
    "  $voices = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })",
    "  if ($voices -contains 'Microsoft David Desktop') { $s.SelectVoice('Microsoft David Desktop') }",
    "  $s.Rate = 1",
    "  $s.Volume = 100",
    "  $s.SetOutputToWaveFile($outPath)",
    "  $s.Speak($text)",
    "  $s.SetOutputToNull()",
    "} finally { $s.Dispose() }",
  ].join("\r\n");

  try {
    const wavBuffer = await new Promise((resolve, reject) => {
      const encodedScript = Buffer.from(script, "utf16le").toString("base64");
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );

      let stderr = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Speech synthesis timed out"));
      }, 30000);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(new Error(stderr || `Speech synthesis exited with ${code}`));
          return;
        }
        try {
          const result = fs.readFileSync(outputPath);
          if (result.length < 44) {
            finish(new Error("Generated WAV is empty or invalid"));
          } else {
            finish(null, result);
          }
        } catch (error) {
          finish(error);
        }
      });
      // The script is supplied through -EncodedCommand, not stdin.
    });

    return `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
  } catch (error) {
    console.warn("[EXILE] Venom speech synthesis unavailable:", error.message);
    return null;
  } finally {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // Temporary audio cleanup must not affect the rest of EXILE.
    }
  }
});

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

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Reuse the existing windows instead of launching duplicates.
    createCompanionWindow();
    createWindow();
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
}
