"use strict";
/**
 * Windows application discovery.
 *
 * Mechanism: enumerate the Start Menu shortcut folders (per-machine and
 * per-user) and read each .lnk with Electron's shell.readShortcutLink. This is
 * the same list of applications Windows itself shows under "All apps", it needs
 * no elevation, and reading a shortcut NEVER runs the program it points to.
 *
 * Not discovered (documented limitation): Microsoft Store / UWP apps (they have
 * no .exe launch target), and programs with no Start Menu shortcut. Those can
 * still be added with "Browse for executable".
 */

const fs = require("node:fs");
const nodePath = require("node:path");
const v = require("./validation.cjs");

const MAX_DEPTH = 6;
const MAX_SHORTCUTS = 3000;
const SKIP_NAME = /(^|\W)(uninstall|uninst|remove|setup|installer|update(r)?|readme|help|documentation|release notes|license)(\W|$)/i;

function startMenuRoots(env = process.env) {
  const roots = [];
  if (env.ProgramData) roots.push(nodePath.win32.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"));
  if (env.APPDATA) roots.push(nodePath.win32.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"));
  return roots;
}

/** Walk a folder collecting .lnk file paths. Never follows symlinks; bounded depth and count. */
function collectShortcuts(root, fsImpl = fs, limit = MAX_SHORTCUTS) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || found.length >= limit) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it, keep scanning
    }
    // readdir order is filesystem-dependent; sort so scans are repeatable.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = nodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * @param {object} deps
 * @param {string[]} deps.roots           folders to scan
 * @param {(lnk:string)=>{target?:string,args?:string}} deps.readShortcut
 * @param {(p:string)=>object} deps.inspect   returns inspectExecutable-style result
 * @param {string} deps.platform
 * @param {object} [deps.fs]
 * @returns {{candidates: object[], skipped: {reason:string,count:number}[], scanned:number}}
 */
function discoverFromShortcuts({ roots, readShortcut, inspect, platform, fs: fsImpl = fs }) {
  const byKey = new Map();
  const skipped = new Map();
  const skip = (reason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let scanned = 0;

  for (const root of roots) {
    for (const lnk of collectShortcuts(root, fsImpl)) {
      scanned++;
      const name = nodePath.basename(lnk).replace(/\.lnk$/i, "");
      if (SKIP_NAME.test(name)) { skip("installer, uninstaller or help shortcut"); continue; }

      let info;
      try {
        info = readShortcut(lnk);
      } catch {
        skip("shortcut could not be read");
        continue;
      }
      const target = info && typeof info.target === "string" ? info.target : "";
      if (!target) { skip("shortcut has no program target"); continue; }

      const checked = inspect(target);
      if (!checked.ok) {
        skip(checked.error?.code === "invalid-path" ? "target is not a plain .exe program" : "target program is missing or unreadable");
        continue;
      }

      const parsedArgs = v.parseArgumentString(typeof info.args === "string" ? info.args : "");
      if (!parsedArgs.ok) { skip("shortcut arguments are not supported"); continue; }
      if (!v.validateProgramAndArgs(checked.path, parsedArgs.args, platform).ok) {
        skip("command interpreter with arguments");
        continue;
      }
      const cleanName = v.validateName(name);
      if (!cleanName.ok) { skip("unusable shortcut name"); continue; }

      const key = v.dedupeKey(checked.path, parsedArgs.args, platform);
      const existing = byKey.get(key);
      // Several shortcuts can point at one program ("Editor", "Editor (Admin)").
      // Keep one entry, preferring the shortest name so the result never depends on scan order.
      if (existing && (existing.name.length < cleanName.value.length ||
        (existing.name.length === cleanName.value.length && existing.name <= cleanName.value))) continue;
      byKey.set(key, {
        name: cleanName.value,
        executablePath: checked.path,
        args: parsedArgs.args,
        shortcutPath: lnk,
      });
    }
  }

  const candidates = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    candidates,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    scanned,
  };
}

module.exports = { startMenuRoots, collectShortcuts, discoverFromShortcuts, MAX_DEPTH, MAX_SHORTCUTS };
