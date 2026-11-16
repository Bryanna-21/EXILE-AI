const { app, BrowserWindow, shell, ipcMain, dialog, session } = require("electron");
const path = require("node:path");
const { registerNativeAppIpc, isTrustedSender } = require("./native-apps/index.cjs");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");

// Per-launch secret for the local API. Kept in memory only and never exposed to renderer JS.
const LOCAL_API_SECRET = crypto.randomBytes(32).toString("base64url");
const os = require("node:os");

if (process.platform === "win32") {
  app.setAppUserModelId("com.exile.ai");
}

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
let apiLogStream = null;
let mainWindow = null;
let companionWindow = null;
const trustedApiWebContents = new Set();

function trustApiWebContents(win) {
  const wc = win.webContents;
  trustedApiWebContents.add(wc.id);
  wc.once("destroyed", () => {
    trustedApiWebContents.delete(wc.id);
  });
}

/**
 * Attach local API authentication in Chromium's main process.
 * Only the two trusted EXILE windows receive the header, and only for loopback URLs.
 */
function configureLocalApiRequestAuth() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://localhost/*", "http://127.0.0.1/*"] },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      let hostname = "";

      try {
        hostname = new URL(details.url).hostname;
      } catch {
        // Leave malformed destinations untouched.
      }

      if (
        trustedApiWebContents.has(details.webContentsId) &&
        (hostname === "localhost" || hostname === "127.0.0.1")
      ) {
        requestHeaders["x-exile-local-auth"] = LOCAL_API_SECRET;
      }

      callback({ requestHeaders });
    },
  );
}

async function startLocalApi() {
  const appRoot = app.getAppPath();
  const serverPath = path.join(appRoot, "local", "server.mjs");

  if (!fs.existsSync(serverPath)) {
    console.error("[EXILE] Local API entry point is missing:", serverPath);
    return false;
  }

  const dataDir = app.getPath("userData");
  const logPath = path.join(dataDir, "logs", "exile-api.log");
  const port = process.env.EXILE_PORT || "8787";
  const healthUrl = `http://127.0.0.1:${port}/health`;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    apiLogStream = fs.createWriteStream(logPath, { flags: "a" });
    apiLogStream.write(
      "\n===== EXILE API START " + new Date().toISOString() + " =====\n",
    );

    apiProc = spawn(process.execPath, [serverPath], {
      cwd: app.isPackaged ? path.dirname(process.execPath) : appRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        EXILE_PORT: port,
        EXILE_LOCAL_API_SECRET: LOCAL_API_SECRET,
        ...(app.isPackaged ? {
          EXILE_DATA_DIR: dataDir,
          EXILE_TASK_STORE_DIR: path.join(dataDir, ".exile-ai", "tasks"),
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const child = apiProc;

    const captureApiOutput = (label, chunk) => {
      if (!apiLogStream) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) apiLogStream.write(`[${label}] ${line}\n`);
      }
    };

    child.stdout.on("data", (chunk) => captureApiOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => captureApiOutput("stderr", chunk));

    child.on("error", (error) => {
      apiLogStream?.write(`[process error] ${error.message}\n`);
      if (apiProc === child) apiProc = null;
    });

    child.on("exit", (code, signal) => {
      apiLogStream?.write(`[process exit] code=${code} signal=${signal}\n`);
      if (apiProc === child) apiProc = null;
      apiLogStream?.end();
      apiLogStream = null;
    });

    // Do not expose the UI as ready until the local API answers health checks.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.killed) break;
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(1200),
        });
        if (response.ok) {
          apiLogStream?.write("[health] Local API is ready.\n");
          return true;
        }
      } catch {
        // The API may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    apiLogStream?.write("[health] Local API did not become ready in time.\n");
    return false;
  } catch (error) {
    apiLogStream?.write(`[startup error] ${error.message}\n`);
    return false;
  }
}

function stopLocalApi() {
  const child = apiProc;
  apiProc = null;

  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch (error) {
      console.warn("[EXILE] Could not stop local API:", error.message);
    }
  }

  if (apiLogStream) {
    apiLogStream.end();
    apiLogStream = null;
  }
}

function openExternalSafely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") shell.openExternal(url);
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

// Permissions the UI genuinely uses (microphone/camera for voice and capture, user-initiated location in System Access, clipboard writes, fullscreen,
// notifications). Everything else (MIDI, USB, HID, serial, ...) is denied, and only for the app's
// own file:// pages; Electron's default is to grant every request.
const ALLOWED_PERMISSIONS = new Set(["media", "geolocation", "clipboard-sanitized-write", "fullscreen", "notifications"]);

function configureWindowSecurity(win) {
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  // The preload bridge (native app launching, the local API secret) must never be attached to a remote page.
  // The window may only ever show the bundled index.html; any other navigation is refused, and web links open
  // in the system browser instead.
  const guardNavigation = (event, url) => {
    let same = false;
    try {
      const target = new URL(url);
      same = target.protocol === "file:" && path.resolve(fileURLToPath(target)) === path.resolve(__dirname, "..", "dist", "index.html");
    } catch {
      same = false;
    }
    if (!same) {
      event.preventDefault();
      openExternalSafely(url);
    }
  };
  wc.on("will-navigate", guardNavigation);
  wc.on("will-redirect", guardNavigation);
  wc.on("will-attach-webview", (event) => event.preventDefault());

  wc.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = String(details?.requestingUrl || contents.getURL() || "");
    callback(origin.startsWith("file://") && ALLOWED_PERMISSIONS.has(permission));
  });
  wc.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return String(requestingOrigin || "").startsWith("file://") && ALLOWED_PERMISSIONS.has(permission);
  });
}

function configureExternalLinks(win) {
  configureWindowSecurity(win);
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

trustApiWebContents(mainWindow);
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

trustApiWebContents(companionWindow);
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


ipcMain.handle("exile:venom-synthesize", async (event, text, profileId) => {
  // Only the local Electron UI may request speech synthesis.
  if (!isTrustedSender(event, path.resolve(__dirname, "..", "dist", "index.html"), process.platform)) return null;
  if (typeof text !== "string" || !text.trim() || text.length > 3000) {
    return null;
  }

  const safeProfileId = profileId === "jarvis" ? "jarvis" : "venom";
  const outputPath = path.join(
    os.tmpdir(),
    `exile-${safeProfileId}-${process.pid}-${Date.now()}.wav`,
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
    `  $profile = '${safeProfileId}'`,
    "  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })",
    "  if ($profile -eq 'jarvis') {",
    "    $choice = $voices | Where-Object { $_.Name -eq 'Microsoft David Desktop' -and $_.Gender -eq 'Male' } | Select-Object -First 1",
    "    if (-not $choice) { $choice = $voices | Where-Object { $_.Culture.Name -like 'en-*' -and $_.Gender -eq 'Male' } | Select-Object -First 1 }",
    "    if (-not $choice) { throw 'JARVIS requires an installed male English voice. No suitable voice was found.' }",
    "  } else {",
    "    $choice = $voices | Where-Object { $_.Culture.Name -like 'en-*' -and $_.Gender -eq 'Male' } | Select-Object -First 1",
    "    if (-not $choice) { $choice = $voices | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }",
    "  }",
    "  if ($choice) { $s.SelectVoice($choice.Name) }",
    `  $s.Rate = ${safeProfileId === "jarvis" ? 0 : -2}`,
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

  app.whenReady().then(async () => {
    configureLocalApiRequestAuth();
    // Native application import/launch: main-process only, narrow IPC surface.
    try {
      registerNativeAppIpc({ ipcMain, app, dialog, shell, BrowserWindow });
    } catch (error) {
      console.error("[EXILE] Native application support failed to start:", error.message);
    }

    const apiReady = await startLocalApi();
    if (!apiReady) {
      console.error(
        "[EXILE] Local API did not become ready. See:",
        path.join(app.getPath("userData"), "logs", "exile-api.log"),
      );
    }

    createWindow();
    createCompanionWindow();

    app.on("activate", () => {
      createWindow();
      createCompanionWindow();
    });
  });

  app.on("before-quit", () => {
    stopLocalApi();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
