const { contextBridge, ipcRenderer } = require("electron");

// Narrow, fixed set of native application operations. Each one maps to a single
// validated main-process handler. There is no generic invoke/send exposed, and
// no way for the page to name an executable path: paths come from native file
// dialogs or from scan results held by the main process.
const nativeApps = Object.freeze({
  list: () => ipcRenderer.invoke("exile:apps:list"),
  discover: () => ipcRenderer.invoke("exile:apps:discover"),
  importDiscovered: (candidateIds) => ipcRenderer.invoke("exile:apps:import-discovered", candidateIds),
  importManual: () => ipcRenderer.invoke("exile:apps:import-manual"),
  importShortcut: () => ipcRenderer.invoke("exile:apps:import-shortcut"),
  update: (id, patch) => ipcRenderer.invoke("exile:apps:update", id, patch),
  remove: (id) => ipcRenderer.invoke("exile:apps:remove", id),
  relink: (id) => ipcRenderer.invoke("exile:apps:relink", id),
  reorder: (orderedIds) => ipcRenderer.invoke("exile:apps:reorder", orderedIds),
  launch: (id) => ipcRenderer.invoke("exile:apps:launch", id),
  refresh: () => ipcRenderer.invoke("exile:apps:refresh"),
  history: () => ipcRenderer.invoke("exile:apps:history"),
  clearHistory: () => ipcRenderer.invoke("exile:apps:clear-history"),
});

contextBridge.exposeInMainWorld("exileDesktop", {
  openDashboard: () => ipcRenderer.send("exile:open-dashboard"),
  minimizeCompanion: () => ipcRenderer.send("exile:minimize-companion"),
  closeCompanion: () => ipcRenderer.send("exile:close-companion"),
  synthesizeVenom: (text, profileId) => ipcRenderer.invoke("exile:venom-synthesize", text, profileId),
  nativeApps,
});
