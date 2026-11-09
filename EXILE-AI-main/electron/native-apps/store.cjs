"use strict";
/**
 * Persistent store for imported native applications.
 *
 * One small JSON file in the app's userData directory, written atomically
 * (temp file + fsync + rename, owner-only permissions). The data never leaves
 * the machine. A corrupt or partly invalid file is backed up before anything is
 * dropped, so a bad write can never silently destroy the user's list.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const v = require("./validation.cjs");

const STORE_VERSION = 1;
const SOURCES = new Set(["manual", "discovered", "shortcut"]);

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw error;
  }
}

/** Re-validate a stored entry. Returns a clean entry or null when it is unusable. */
function sanitizeEntry(raw, platform) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.id)) return null;
  const name = v.validateName(raw.name);
  if (!name.ok) return null;
  const exe = v.validateExecutablePathSyntax(raw.executablePath, platform);
  if (!exe.ok) return null;
  const args = v.validateArgumentArray(raw.args ?? []);
  if (!args.ok) return null;
  if (!v.validateProgramAndArgs(exe.path, args.args, platform).ok) return null;
  const category = v.validateCategory(raw.category);
  if (!category.ok) return null;
  const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
  return {
    id: raw.id,
    name: name.value,
    executablePath: exe.path,
    args: args.args,
    category: category.value,
    favorite: raw.favorite === true,
    source: SOURCES.has(raw.source) ? raw.source : "manual",
    addedAt: num(raw.addedAt, Date.now()),
    lastLaunchedAt: Number.isFinite(raw.lastLaunchedAt) ? raw.lastLaunchedAt : null,
    launchCount: Math.max(0, Math.trunc(num(raw.launchCount))),
  };
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    if (typeof h.appId !== "string" || !Number.isFinite(h.at)) continue;
    out.push({
      appId: h.appId.slice(0, 64),
      name: typeof h.name === "string" ? h.name.slice(0, v.LIMITS.nameMax) : "",
      at: h.at,
      outcome: h.outcome === "launched" ? "launched" : "failed",
      error: typeof h.error === "string" ? h.error.slice(0, 300) : null,
    });
  }
  return out.slice(-v.LIMITS.historyMax);
}

class NativeAppStore {
  /**
   * @param {string} file absolute path of the JSON file
   * @param {string} platform process.platform value (injectable for tests)
   */
  constructor(file, platform = process.platform) {
    this.file = file;
    this.platform = platform;
    this.apps = [];
    this.history = [];
    this.loadWarning = null;
    this._load();
  }

  _backup(reason) {
    try {
      const target = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, target);
      return target;
    } catch {
      return null;
    }
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      this.loadWarning = `The application list could not be read (${error.code || "error"}). Starting empty; the file was left untouched.`;
      this._readOnlyBecauseUnreadable = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const backup = this._backup("unparseable");
      this.loadWarning = `The saved application list was corrupt and has been backed up${backup ? ` to ${path.basename(backup)}` : ""}. Starting empty.`;
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.apps)) {
      const backup = this._backup("shape");
      this.loadWarning = `The saved application list had an unexpected format and has been backed up${backup ? ` to ${path.basename(backup)}` : ""}. Starting empty.`;
      return;
    }
    if (Number.isFinite(parsed.version) && parsed.version > STORE_VERSION) {
      this._backup("newer-version");
      this.loadWarning = "The saved application list was written by a newer version of EXILE. It has been backed up and will not be modified until you update.";
      this._readOnlyBecauseNewer = true;
      return;
    }
    const seenIds = new Set();
    const seenKeys = new Set();
    let dropped = 0;
    for (const raw of parsed.apps) {
      const entry = sanitizeEntry(raw, this.platform);
      if (!entry) { dropped++; continue; }
      const key = v.dedupeKey(entry.executablePath, entry.args, this.platform);
      if (seenIds.has(entry.id) || seenKeys.has(key)) { dropped++; continue; }
      seenIds.add(entry.id);
      seenKeys.add(key);
      this.apps.push(entry);
    }
    this.history = sanitizeHistory(parsed.history);
    if (dropped > 0) {
      const backup = this._backup("dropped");
      this.loadWarning = `${dropped} saved application${dropped === 1 ? " was" : "s were"} invalid and skipped. The original file was backed up${backup ? ` to ${path.basename(backup)}` : ""}.`;
    }
  }

  /** Persist current state. Throws if the file must not be modified. */
  save() {
    if (this._readOnlyBecauseUnreadable || this._readOnlyBecauseNewer) {
      throw Object.assign(new Error("The saved application list cannot be modified right now."), { code: "store-readonly" });
    }
    this.history = this.history.slice(-v.LIMITS.historyMax);
    writeJsonAtomic(this.file, { version: STORE_VERSION, apps: this.apps, history: this.history });
  }

  get(id) {
    return this.apps.find((a) => a.id === id) ?? null;
  }

  findDuplicate(exePath, args, exceptId = null) {
    const key = v.dedupeKey(exePath, args, this.platform);
    return this.apps.find((a) => a.id !== exceptId && v.dedupeKey(a.executablePath, a.args, this.platform) === key) ?? null;
  }

  newId() {
    return crypto.randomUUID();
  }
}

module.exports = { NativeAppStore, STORE_VERSION, writeJsonAtomic, sanitizeEntry };
