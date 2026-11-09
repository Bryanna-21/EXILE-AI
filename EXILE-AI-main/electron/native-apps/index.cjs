"use strict";
/**
 * Wires the native application service to Electron and registers IPC handlers.
 *
 * Every handler:
 *   1. rejects callers that are not the app's own file:// pages,
 *   2. validates argument shapes before touching the service,
 *   3. returns plain JSON ({ ok, ... }) and never throws across the bridge.
 * Only the narrow operations listed in CHANNELS exist; there is no generic
 * "run this" channel.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { spawn } = require("node:child_process");
const { NativeAppStore } = require("./store.cjs");
const { createNativeAppService } = require("./service.cjs");
const { startMenuRoots } = require("./discovery.cjs");
const v = require("./validation.cjs");

const CHANNELS = Object.freeze({
  list: "exile:apps:list",
  discover: "exile:apps:discover",
  importDiscovered: "exile:apps:import-discovered",
  importManual: "exile:apps:import-manual",
  importShortcut: "exile:apps:import-shortcut",
  update: "exile:apps:update",
  remove: "exile:apps:remove",
  relink: "exile:apps:relink",
  reorder: "exile:apps:reorder",
  launch: "exile:apps:launch",
  refresh: "exile:apps:refresh",
  history: "exile:apps:history",
  clearHistory: "exile:apps:clear-history",
});

function isTrustedSender(event, expectedFilePath, platform = process.platform) {
  const frame = event && event.senderFrame;
  const sender = event && event.sender;

  // Only the top-level frame belonging to this WebContents may call native IPC.
  if (!frame || !sender || frame !== sender.mainFrame) return false;
  if (typeof frame.url !== "string" || typeof expectedFilePath !== "string") return false;

  try {
    const parsed = new URL(frame.url);
    if (parsed.protocol !== "file:" || parsed.hash) return false;
    if (parsed.search !== "" && parsed.search !== "?exileWindow=companion") return false;

    const actual = path.resolve(fileURLToPath(parsed));
    const expected = path.resolve(expectedFilePath);

    return platform === "win32"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  } catch {
    return false;
  }
}

const isId = (x) => typeof x === "string" && x.length > 0 && x.length <= 64;

function registerNativeAppIpc({ ipcMain, app, dialog, shell, BrowserWindow }) {
  const platform = process.platform;
  const trustedRendererPath = path.resolve(app.getAppPath(), "dist", "index.html");
  const store = new NativeAppStore(path.join(app.getPath("userData"), "native-apps.json"), platform);

  const service = createNativeAppService({
    store,
    platform,
    spawn,
    inspect: (p) => v.inspectExecutable(p, platform, fs),
    readShortcut: (lnk) => {
      const info = shell.readShortcutLink(lnk); // reads the .lnk file; does not run its target
      return { target: info.target, args: info.args };
    },
    startMenuRoots: () => startMenuRoots(process.env),
    chooseExecutable: async (parent) => {
      const result = await dialog.showOpenDialog(parent ?? undefined, {
        title: "Choose a program to add to EXILE",
        properties: ["openFile"],
        filters: platform === "win32"
          ? [{ name: "Programs", extensions: ["exe"] }]
          : [{ name: "All files", extensions: ["*"] }],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    chooseShortcut: async (parent) => {
      const result = await dialog.showOpenDialog(parent ?? undefined, {
        title: "Choose a shortcut to import",
        properties: ["openFile"],
        filters: [{ name: "Shortcuts", extensions: ["lnk"] }],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    confirm: async (parent, { title, message, detail }) => {
      const result = await dialog.showMessageBox(parent ?? undefined, {
        type: "warning",
        title,
        message,
        detail,
        buttons: ["Cancel", "Allow"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    getIcon: async (realPath) => {
      const image = await app.getFileIcon(realPath, { size: "normal" });
      return image.isEmpty() ? null : image.toDataURL();
    },
  });

  const parentOf = (event) => {
    try { return BrowserWindow.fromWebContents(event.sender) ?? undefined; } catch { return undefined; }
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, trustedRendererPath, platform)) {
        return { ok: false, error: { code: "forbidden", message: "This request did not come from the EXILE app." } };
      }
      try {
        return await fn(event, ...args);
      } catch (error) {
        console.error(`[EXILE] ${channel} failed:`, error && error.message);
        return { ok: false, error: { code: "internal", message: "Something went wrong. Please try again." } };
      }
    });
  };

  const bad = (message) => ({ ok: false, error: { code: "invalid-request", message } });

  handle(CHANNELS.list, () => service.list());
  handle(CHANNELS.discover, () => service.discover());
  handle(CHANNELS.importDiscovered, (e, ids) => (Array.isArray(ids) ? service.importDiscovered(ids, parentOf(e)) : bad("Choose at least one application.")));
  handle(CHANNELS.importManual, (e) => service.importManual(parentOf(e)));
  handle(CHANNELS.importShortcut, (e) => service.importShortcut(parentOf(e)));
  handle(CHANNELS.update, (e, id, patch) => (isId(id) ? service.update(parentOf(e), id, patch) : bad("Unknown application.")));
  handle(CHANNELS.remove, (_e, id) => (isId(id) ? service.remove(id) : bad("Unknown application.")));
  handle(CHANNELS.relink, (e, id) => (isId(id) ? service.relink(parentOf(e), id) : bad("Unknown application.")));
  handle(CHANNELS.reorder, (_e, ids) => service.reorder(ids));
  handle(CHANNELS.launch, (_e, id) => (isId(id) ? service.launch(id) : bad("Unknown application.")));
  handle(CHANNELS.refresh, () => service.refresh());
  handle(CHANNELS.history, () => service.history());
  handle(CHANNELS.clearHistory, () => service.clearHistory());

  return { service, store };
}

module.exports = { registerNativeAppIpc, CHANNELS, isTrustedSender };
