// Static checks on the Electron main process source. These cannot prove runtime behaviour (Electron is not
// launched in CI/sandbox); they guard against the security configuration being silently removed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");

const localApi = fs.readFileSync(path.join(root, "src/lib/localApi.ts"), "utf8");
const desktopTypes = fs.readFileSync(path.join(root, "src/types/exileDesktop.d.ts"), "utf8");

test("local API authentication is installed before the API and windows start", () => {
  const ready = main.indexOf("app.whenReady().then(async () => {");
  const hook = main.indexOf("configureLocalApiRequestAuth();", ready);
  const api = main.indexOf("await startLocalApi();", ready);
  const window = main.indexOf("createWindow();", ready);

  assert.ok(ready >= 0, "startup handler must exist");
  assert.ok(hook > ready, "authentication hook must be inside startup");
  assert.ok(api > hook, "authentication must be installed before the API starts");
  assert.ok(window > hook, "authentication must be installed before windows are created");
  assert.equal((main.match(/configureLocalApiRequestAuth\(\);/g) ?? []).length, 1);
});

test("both application windows are trusted before loading and trust is revoked on destruction", () => {
  assert.match(main, /trustApiWebContents\(mainWindow\);\s*mainWindow\.loadFile\(/);
  assert.match(main, /trustApiWebContents\(companionWindow\);\s*companionWindow\.loadFile\(/);
  assert.match(main, /wc\.once\(["']destroyed["'],\s*\(\)\s*=>\s*\{\s*trustedApiWebContents\.delete\(wc\.id\)/);
  assert.match(main, /trustedApiWebContents\.has\(details\.webContentsId\)/);
  assert.match(main, /hostname === "localhost" \|\| hostname === "127\.0\.0\.1"/);
});

test("the Electron renderer never receives the local API secret", () => {
  assert.doesNotMatch(preload, /localApiSecret|exile-local-api-secret/);
  assert.doesNotMatch(desktopTypes, /localApiSecret/);
  assert.doesNotMatch(localApi, /window\.exileDesktop\?\.localApiSecret/);
  assert.match(localApi, /meta\[name="exile-local-api-secret"\]/);
  assert.match(localApi, /VITE_EXILE_LOCAL_API_SECRET/);
});

test("every BrowserWindow keeps sandbox, context isolation and no node integration", () => {
  const windows = main.match(/new BrowserWindow\(/g) ?? [];
  assert.ok(windows.length >= 2);
  assert.equal((main.match(/sandbox: true/g) ?? []).length, windows.length);
  assert.equal((main.match(/contextIsolation: true/g) ?? []).length, windows.length);
  assert.equal((main.match(/nodeIntegration: false/g) ?? []).length, windows.length);
  assert.ok(!/webSecurity:\s*false|allowRunningInsecureContent:\s*true|nodeIntegration:\s*true|enableRemoteModule/.test(main));
});

test("windows cannot navigate away from the bundled page or attach webviews; permissions are allow-listed", () => {
  assert.match(main, /will-navigate/);
  assert.match(main, /will-redirect/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /configureWindowSecurity\(win\)/);
});

test("the API secret is generated per launch, kept in memory, never logged or written", () => {
  assert.match(main, /randomBytes\(32\)/);
  assert.ok(!/(console\.\w+|write|writeFile\w*)\([^)]*LOCAL_API_SECRET/.test(main));
});

test("the preload exposes no generic IPC channel", () => {
  assert.ok(!/ipcRenderer\.(send|invoke)\(\s*[a-z]\w*\s*[,)]/.test(preload), "channels must be fixed strings");
  assert.ok(!/exposeInMainWorld\("\w+",\s*ipcRenderer/.test(preload));
});

test("speech synthesis IPC verifies the sender frame", () => {
  assert.match(main, /exile:venom-synthesize[\s\S]{0,200}isTrustedSender/);
});
