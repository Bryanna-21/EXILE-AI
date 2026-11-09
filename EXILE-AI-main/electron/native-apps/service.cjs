"use strict";
/**
 * Native application service (Electron main process).
 *
 * All side effects are injected so the same code is unit-tested against a real
 * temp directory and real child processes:
 *   deps.store, deps.platform, deps.fs, deps.spawn, deps.inspect
 *   deps.chooseExecutable(parent)  -> Promise<string|null>   native file dialog
 *   deps.chooseShortcut(parent)    -> Promise<string|null>   native file dialog
 *   deps.readShortcut(lnk)         -> { target, args }
 *   deps.confirm(parent, {title, message, detail}) -> Promise<boolean>  native dialog
 *   deps.getIcon(path)             -> Promise<string|null>   data URL
 *   deps.startMenuRoots()          -> string[]
 *
 * Security properties:
 *   - The renderer never supplies an executable path. Paths come only from native
 *     file dialogs or from scan results held here (referenced by candidate id).
 *   - Launch is by stored id. spawn() is always called with shell:false and an
 *     argv array, so no string is ever interpreted by a shell.
 *   - Discovery and import only read files; nothing is executed.
 */

const nodePath = require("node:path");
const v = require("./validation.cjs");
const { discoverFromShortcuts } = require("./discovery.cjs");

const CANDIDATE_TTL_MS = 15 * 60 * 1000;
const LAUNCH_CONFIRM_TIMEOUT_MS = 8000;

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function createNativeAppService(deps) {
  const { store, platform } = deps;
  const support = v.platformSupport(platform);
  // Path rules follow the target platform, not whichever OS runs the code.
  const pathMod = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const running = new Map(); // appId -> { pid, startedAt }
  const iconCache = new Map(); // realPath -> data URL | null
  let scan = { at: 0, candidates: new Map() }; // candidateId -> candidate

  const ensureSupported = () => (support.supported ? null : err("unsupported-platform", "Native application import is not supported on this operating system."));

  function availabilityOf(app) {
    const checked = deps.inspect(app.executablePath);
    if (checked.ok) return { availability: "available", availabilityMessage: null, realPath: checked.realPath };
    return { availability: checked.status, availabilityMessage: checked.error.message, realPath: null };
  }

  async function iconFor(realPath) {
    if (!realPath || !deps.getIcon) return null;
    if (iconCache.has(realPath)) return iconCache.get(realPath);
    let icon = null;
    try { icon = await deps.getIcon(realPath); } catch { icon = null; }
    iconCache.set(realPath, icon);
    return icon;
  }

  async function toView(app) {
    const a = availabilityOf(app);
    return {
      id: app.id,
      name: app.name,
      executablePath: app.executablePath,
      args: app.args,
      category: app.category,
      favorite: app.favorite,
      source: app.source,
      addedAt: app.addedAt,
      lastLaunchedAt: app.lastLaunchedAt,
      launchCount: app.launchCount,
      availability: a.availability,
      availabilityMessage: a.availabilityMessage,
      running: running.has(app.id),
      pid: running.get(app.id)?.pid ?? null,
      icon: await iconFor(a.realPath),
    };
  }

  async function snapshot(extra = {}) {
    const apps = await Promise.all(store.apps.map(toView));
    return {
      ok: true,
      platform,
      support,
      warning: store.loadWarning,
      apps,
      ...extra,
    };
  }

  function persist() {
    try {
      store.save();
      return null;
    } catch (e) {
      return err("store-failed", e && e.code === "store-readonly" ? e.message : "The application list could not be saved.");
    }
  }

  /** Validate and add one entry. `ctx` is the caller's label for error text. */
  function addEntry({ name, executablePath, args, source, category = "" }) {
    if (store.apps.length >= v.LIMITS.maxApps) {
      return err("limit", `You can import at most ${v.LIMITS.maxApps} applications.`);
    }
    const checked = deps.inspect(executablePath);
    if (!checked.ok) return { ok: false, error: checked.error, status: checked.status };
    const cleanName = v.validateName(name);
    if (!cleanName.ok) return cleanName;
    const cleanArgs = v.validateArgumentArray(args);
    if (!cleanArgs.ok) return cleanArgs;
    const rule = v.validateProgramAndArgs(checked.path, cleanArgs.args, platform);
    if (!rule.ok) return rule;
    const cat = v.validateCategory(category);
    if (!cat.ok) return cat;
    const dup = store.findDuplicate(checked.path, cleanArgs.args);
    if (dup) return { ok: false, duplicateOf: dup.id, error: { code: "duplicate", message: `"${dup.name}" is already in your list with the same program and arguments.` } };
    const entry = {
      id: store.newId(),
      name: cleanName.value,
      executablePath: checked.path,
      args: cleanArgs.args,
      category: cat.value,
      favorite: false,
      source,
      addedAt: Date.now(),
      lastLaunchedAt: null,
      launchCount: 0,
    };
    store.apps.push(entry);
    return { ok: true, entry };
  }

  /* ------------------------------ public API ------------------------------ */

  async function list() {
    return snapshot();
  }

  async function discover() {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    if (!support.discovery) {
      return err("discovery-unavailable", "Automatic discovery is not available on this operating system yet. Use \"Browse for executable\" instead.");
    }
    const result = discoverFromShortcuts({
      roots: deps.startMenuRoots(),
      readShortcut: deps.readShortcut,
      inspect: deps.inspect,
      platform,
    });
    const map = new Map();
    const view = result.candidates.map((c) => {
      const id = store.newId();
      map.set(id, c);
      return {
        candidateId: id,
        name: c.name,
        executablePath: c.executablePath,
        args: c.args,
        alreadyImported: !!store.findDuplicate(c.executablePath, c.args),
      };
    });
    scan = { at: Date.now(), candidates: map };
    return { ok: true, candidates: view, skipped: result.skipped, scanned: result.scanned };
  }

  /** Import previously scanned candidates by id. Paths come from main's own scan results. */
  async function importDiscovered(candidateIds, parent) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.length > v.LIMITS.maxApps) {
      return err("invalid-request", "Choose at least one application to import.");
    }
    if (Date.now() - scan.at > CANDIDATE_TTL_MS || scan.candidates.size === 0) {
      return err("scan-expired", "The scan results are out of date. Scan again, then import.");
    }
    const imported = [];
    const failed = [];
    for (const id of [...new Set(candidateIds)]) {
      const cand = typeof id === "string" ? scan.candidates.get(id) : null;
      if (!cand) { failed.push({ name: "(unknown)", message: "That scan result is no longer available." }); continue; }
      if (cand.args.length > 0) {
        const approved = await deps.confirm(parent, {
          title: "Import application with launch arguments?",
          message: `EXILE will start "${cand.name}" with these arguments every time:`,
          detail: `${cand.executablePath}\n\n${cand.args.map((a) => JSON.stringify(a)).join(" ")}\n\nOnly continue if you trust this shortcut and its arguments.`,
        });
        if (!approved) {
          failed.push({ name: cand.name, message: "Import cancelled because launch arguments were not approved." });
          continue;
        }
      }
      const r = addEntry({ name: cand.name, executablePath: cand.executablePath, args: cand.args, source: "discovered" });
      if (r.ok) imported.push(r.entry.name);
      else failed.push({ name: cand.name, message: r.error.message, duplicate: r.error.code === "duplicate" });
    }
    if (imported.length) {
      const saveError = persist();
      if (saveError) return saveError;
    }
    return snapshot({ imported, failed });
  }

  async function importManual(parent) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    if (!support.manualImport) return err("unsupported-platform", "Manual import is not available on this operating system.");
    const chosen = await deps.chooseExecutable(parent);
    if (!chosen) return snapshot({ cancelled: true });
    const name = pathMod.basename(chosen).replace(/\.[^.]*$/, "") || "Application";
    const r = addEntry({ name, executablePath: chosen, args: [], source: "manual" });
    if (!r.ok) return r;
    const saveError = persist();
    if (saveError) { store.apps.pop(); return saveError; }
    return snapshot({ imported: [r.entry.name], addedId: r.entry.id });
  }

  async function importShortcut(parent) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    if (!support.shortcutImport) return err("unsupported-platform", "Shortcut import is not available on this operating system.");
    const chosen = await deps.chooseShortcut(parent);
    if (!chosen) return snapshot({ cancelled: true });
    if (!/\.lnk$/i.test(chosen)) return err("invalid-path", "Choose a .lnk shortcut file.");
    let info;
    try {
      info = deps.readShortcut(chosen);
    } catch {
      return err("invalid-shortcut", "That shortcut could not be read.");
    }
    const target = info && typeof info.target === "string" ? info.target : "";
    if (!target) return err("invalid-shortcut", "That shortcut does not point to a program (it may be a folder, document or Store app).");
    const parsed = v.parseArgumentString(typeof info.args === "string" ? info.args : "");
    if (!parsed.ok) return parsed;
    const name = pathMod.basename(chosen).replace(/\.lnk$/i, "");
    if (parsed.args.length > 0) {
      const approved = await deps.confirm(parent, {
        title: "Import shortcut with launch arguments?",
        message: `EXILE will start "${name}" with these arguments every time:`,
        detail: `${target}\n\n${parsed.args.map((a) => JSON.stringify(a)).join(" ")}\n\nOnly continue if you trust this shortcut and its arguments.`,
      });
      if (!approved) return snapshot({ cancelled: true });
    }
    const r = addEntry({ name, executablePath: target, args: parsed.args, source: "shortcut" });
    if (!r.ok) return r;
    const saveError = persist();
    if (saveError) { store.apps.pop(); return saveError; }
    return snapshot({ imported: [r.entry.name], addedId: r.entry.id });
  }

  /**
   * Edit name, category, favourite and launch arguments. Changing arguments needs
   * a native confirmation, because arguments change what the program does and
   * the renderer is not trusted to approve that itself.
   */
  async function update(parent, id, patch) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    const app = typeof id === "string" ? store.get(id) : null;
    if (!app) return err("not-found", "That application is no longer in your list.");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return err("invalid-request", "Nothing to update.");
    const allowed = new Set(["name", "category", "favorite", "argsText"]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) return err("invalid-request", `"${key}" cannot be edited.`);
    }

    const next = { ...app };
    if ("name" in patch) {
      const r = v.validateName(patch.name);
      if (!r.ok) return r;
      next.name = r.value;
    }
    if ("category" in patch) {
      const r = v.validateCategory(patch.category);
      if (!r.ok) return r;
      next.category = r.value;
    }
    if ("favorite" in patch) {
      if (typeof patch.favorite !== "boolean") return err("invalid-request", "favorite must be true or false.");
      next.favorite = patch.favorite;
    }
    let argsChanged = false;
    if ("argsText" in patch) {
      const parsed = v.parseArgumentString(patch.argsText);
      if (!parsed.ok) return parsed;
      const rule = v.validateProgramAndArgs(app.executablePath, parsed.args, platform);
      if (!rule.ok) return rule;
      argsChanged = JSON.stringify(parsed.args) !== JSON.stringify(app.args);
      next.args = parsed.args;
    }
    if (next.args !== app.args) {
      const dup = store.findDuplicate(app.executablePath, next.args, app.id);
      if (dup) return err("duplicate", `"${dup.name}" already uses this program with the same arguments.`);
    }
    if (argsChanged && next.args.length > 0) {
      const ok = await deps.confirm(parent, {
        title: "Change launch arguments?",
        message: `EXILE will start "${next.name}" with these arguments every time:`,
        detail: `${app.executablePath}\n\n${next.args.map((a) => JSON.stringify(a)).join(" ")}\n\nOnly continue if you trust these arguments.`,
      });
      if (!ok) return snapshot({ cancelled: true });
    }

    const before = { ...app };
    Object.assign(app, next);
    const saveError = persist();
    if (saveError) { Object.assign(app, before); return saveError; }
    return snapshot();
  }

  async function remove(id) {
    const index = typeof id === "string" ? store.apps.findIndex((a) => a.id === id) : -1;
    if (index < 0) return err("not-found", "That application is no longer in your list.");
    const [removed] = store.apps.splice(index, 1);
    const saveError = persist();
    if (saveError) { store.apps.splice(index, 0, removed); return saveError; }
    running.delete(id);
    return snapshot();
  }

  /** Point an existing entry (for example a missing one) at a new executable chosen in a native dialog. */
  async function relink(parent, id) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    const app = typeof id === "string" ? store.get(id) : null;
    if (!app) return err("not-found", "That application is no longer in your list.");
    const chosen = await deps.chooseExecutable(parent);
    if (!chosen) return snapshot({ cancelled: true });
    const checked = deps.inspect(chosen);
    if (!checked.ok) return { ok: false, error: checked.error, status: checked.status };
    const rule = v.validateProgramAndArgs(checked.path, app.args, platform);
    if (!rule.ok) return rule;
    const dup = store.findDuplicate(checked.path, app.args, app.id);
    if (dup) return err("duplicate", `"${dup.name}" already uses that program with the same arguments.`);
    const previous = app.executablePath;
    app.executablePath = checked.path;
    const saveError = persist();
    if (saveError) { app.executablePath = previous; return saveError; }
    running.delete(id);
    return snapshot();
  }

  async function reorder(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length !== store.apps.length) {
      return err("invalid-request", "The new order does not match your application list.");
    }
    const byId = new Map(store.apps.map((a) => [a.id, a]));
    const seen = new Set();
    const next = [];
    for (const id of orderedIds) {
      if (typeof id !== "string" || seen.has(id) || !byId.has(id)) {
        return err("invalid-request", "The new order does not match your application list.");
      }
      seen.add(id);
      next.push(byId.get(id));
    }
    const previous = store.apps;
    store.apps = next;
    const saveError = persist();
    if (saveError) { store.apps = previous; return saveError; }
    return snapshot();
  }

  function recordHistory(app, outcome, error) {
    store.history.push({ appId: app.id, name: app.name, at: Date.now(), outcome, error: error ?? null });
    if (outcome === "launched") {
      app.lastLaunchedAt = Date.now();
      app.launchCount += 1;
    }
    try { store.save(); } catch { /* history is best effort; the launch already happened */ }
  }

  /**
   * Launch by stored id. Resolves once the OS has either created the process
   * ("spawn") or refused ("error"). It does not wait for the app's window.
   */
  async function launch(id) {
    const unsupported = ensureSupported();
    if (unsupported) return unsupported;
    if (!support.launch) return err("unsupported-platform", "Launching is not available on this operating system.");
    const app = typeof id === "string" ? store.get(id) : null;
    if (!app) return err("not-found", "That application is no longer in your list.");

    if (running.has(app.id)) {
      return snapshot({ launched: false, alreadyRunning: true, message: `"${app.name}" was started by EXILE and still appears to be running.` });
    }

    // Re-check right before launching: the file may have moved, been deleted or become unreadable.
    const checked = deps.inspect(app.executablePath);
    if (!checked.ok) {
      recordHistory(app, "failed", checked.error.message);
      return { ok: false, error: checked.error, status: checked.status };
    }
    const rule = v.validateProgramAndArgs(checked.path, app.args, platform);
    if (!rule.ok) {
      recordHistory(app, "failed", rule.error.message);
      return rule;
    }

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // would make other Electron apps start as plain Node
    delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) if (key.startsWith("EXILE_")) delete env[key];

    const outcome = await new Promise((resolve) => {
      let child;
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => done({ ok: false, message: "The operating system did not confirm the launch in time." }), LAUNCH_CONFIRM_TIMEOUT_MS);
      try {
        const launchPath = checked.realPath;
        if (typeof launchPath !== "string" || !pathMod.isAbsolute(launchPath)) {
          done({ ok: false, message: "The resolved program path is invalid." });
          return;
        }
        child = deps.spawn(launchPath, app.args, {
          shell: false,
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          cwd: pathMod.dirname(launchPath),
          env,
        });
      } catch (e) {
        done({ ok: false, message: launchErrorMessage(e) });
        return;
      }
      child.once("error", (e) => done({ ok: false, message: launchErrorMessage(e) }));
      child.once("spawn", () => {
        child.unref();
        running.set(app.id, { pid: child.pid, startedAt: Date.now() });
        child.once("exit", () => {
          if (running.get(app.id)?.pid === child.pid) running.delete(app.id);
        });
        done({ ok: true, pid: child.pid });
      });
    });

    if (!outcome.ok) {
      recordHistory(app, "failed", outcome.message);
      return err("launch-failed", outcome.message);
    }
    recordHistory(app, "launched", null);
    return snapshot({ launched: true, pid: outcome.pid, message: `"${app.name}" was started. It opens in its own window, outside EXILE.` });
  }

  async function refresh() {
    iconCache.clear();
    return snapshot();
  }

  function history() {
    return { ok: true, history: [...store.history].reverse() };
  }

  function clearHistory() {
    store.history = [];
    const saveError = persist();
    return saveError ?? { ok: true, history: [] };
  }

  /** Called by tests and on app quit; forgets tracking of child processes. */
  function forgetProcesses() {
    running.clear();
  }

  return {
    list, discover, importDiscovered, importManual, importShortcut, update, remove,
    relink, reorder, launch, refresh, history, clearHistory, forgetProcesses,
  };
}

function launchErrorMessage(e) {
  const code = e && e.code;
  if (code === "ENOENT") return "The program could not be found.";
  if (code === "EACCES" || code === "EPERM") return "Windows or the system refused to start this program (permission denied).";
  if (code === "UNKNOWN" || code === "EFTYPE" || code === "ENOEXEC") return "This file could not be started as a program.";
  return `The program could not be started${code ? ` (${code})` : ""}.`;
}

module.exports = { createNativeAppService, launchErrorMessage };
