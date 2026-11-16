/**
 * EXILE task store — atomic, persistent JSON storage for the execution engine.
 *
 * Tasks must survive page refreshes, browser disconnects and local API
 * restarts, so the durable copy lives on disk (never only in the browser).
 * One JSON file per task plus an index file; every write goes through a
 * temp-file + rename pair so a crash mid-write can never corrupt state.
 *
 * Secrets policy: task records hold objectives, plans, tool inputs/outputs and
 * events — never API keys or credentials. `sanitizeRecord` strips anything
 * that looks like a secret before a record is persisted.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TASK_STATUSES, STEP_STATUSES } from "./task-states.mjs";
import fsRetry from "./fs-retry.cjs";
const { renameSyncRetry } = fsRetry;

const SECRET_KEY_RE = /(api[-_]?key|authorization|bearer|password|passwd|secret|token)/i;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g;

/** Keys that would change an object's prototype or shadow built-ins if copied or spread later. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeValue(value, depth = 0) {
  if (depth > 40) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET_VALUE_RE, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class StoredRecordCorruptError extends Error {
  constructor(id, reason) {
    super(`Stored task record ${id} is corrupt and was quarantined: ${reason}`);
    this.name = "StoredRecordCorruptError";
    this.statusCode = 500;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Structural validation of a persisted task record. Returns a list of problems (empty = valid). */
export function validateTaskRecord(record, expectedId) {
  const errors = [];
  if (!isObj(record)) return ["record is not an object"];
  if (typeof record.id !== "string" || !ID_RE.test(record.id)) errors.push("id is missing or malformed");
  if (expectedId !== undefined && record.id !== expectedId) errors.push("id does not match its file name");
  if (!TASK_STATUSES.includes(record.status)) errors.push(`unknown status "${String(record.status).slice(0, 30)}"`);
  if (typeof record.objective !== "string") errors.push("objective is not a string");
  if (record.title !== undefined && typeof record.title !== "string") errors.push("title is not a string");
  if (record.steps !== undefined) {
    if (!Array.isArray(record.steps)) errors.push("steps is not an array");
    else if (record.steps.length > 200) errors.push("too many steps");
    else record.steps.forEach((st, i) => {
      if (!isObj(st) || typeof st.id !== "string") errors.push(`steps[${i}] is malformed`);
      else if (!STEP_STATUSES.includes(st.status)) errors.push(`steps[${i}] has unknown status`);
    });
  }
  for (const key of ["approvals", "events"]) {
    if (record[key] !== undefined && !Array.isArray(record[key])) errors.push(`${key} is not an array`);
  }
  if (record.plan !== undefined && record.plan !== null && !isObj(record.plan)) errors.push("plan is not an object");
  return errors;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameSyncRetry(fs, tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

export class TaskStore {
  constructor(dir) {
    if (!dir) throw new Error("TaskStore requires a data directory.");
    this.dir = dir;
    this.tasksDir = path.join(dir, "tasks");
    this.indexPath = path.join(dir, "tasks-index.json");
    this.lockPath = path.join(dir, "tasks-index.lock");
    this.eventsCap = 300;
    /** Problems found while loading (quarantined files); surfaced to operators, never swallowed. */
    this.integrityWarnings = [];
    fs.mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Cross-process mutex around index read-modify-write. A stale lock (crashed
   * holder) is broken after 10s. In a single process the synchronous fs calls
   * already cannot interleave; this protects against a second server instance.
   */
  _withLock(fn) {
    const deadline = Date.now() + 5000;
    let fd = null;
    for (;;) {
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeSync(fd, String(process.pid));
        break;
      } catch (e) {
        // Windows may report EPERM, rather than EEXIST, when another
        // process holds an exclusive "wx" lock file open. Treat it as
        // contention only when the lock path actually exists.
        let lockExists = e.code === "EEXIST";
        if (e.code === "EPERM" && process.platform === "win32") {
          // The holder may release the lock between openSync failing and
          // existsSync checking it. A writable parent directory makes that
          // race retryable; a genuine directory permission failure is not.
          try {
            fs.accessSync(this.dir, fs.constants.W_OK);
            lockExists = true;
          } catch {
            lockExists = fs.existsSync(this.lockPath);
          }
        }
        if (!lockExists) throw e;
        try {
          if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 10_000) fs.unlinkSync(this.lockPath);
        } catch { /* raced with the holder releasing it */ }
        if (Date.now() > deadline) throw Object.assign(new Error("Task store is busy; try again."), { statusCode: 503 });
        sleepSync(15);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(this.lockPath); } catch {}
    }
  }

  _quarantine(file, reason) {
    const target = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, target); } catch { try { fs.unlinkSync(file); } catch {} }
    this.integrityWarnings.push({ at: new Date().toISOString(), file: path.basename(file), reason: String(reason).slice(0, 200) });
    if (this.integrityWarnings.length > 50) this.integrityWarnings.shift();
  }

  _taskPath(id) {
    // Task ids are generated by this module; refuse anything path-like.
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(id))) {
      throw Object.assign(new Error("Invalid task id."), { statusCode: 400 });
    }
    return path.join(this.tasksDir, `${id}.json`);
  }

  _index() {
    let raw;
    try {
      raw = fs.readFileSync(this.indexPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return this._rebuildIndexIfTasksExist();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Task index is not an array.");
      return parsed
        .filter((e) => isObj(e) && typeof e.id === "string" && ID_RE.test(e.id))
        .map((e) => sanitizeValue(e));
    } catch (error) {
      // The index is only a convenience view of the task files, so when task
      // files exist it is rebuilt from them. If nothing can be recovered we fail
      // closed (and leave the bad file in place) rather than present an empty list.
      const rebuilt = this._rebuildIndexIfTasksExist({ write: false });
      if (rebuilt.length === 0) {
        throw new Error(`Task index is unreadable or corrupt: ${error.message}`, { cause: error });
      }
      this._quarantine(this.indexPath, `unreadable index: ${error.message}`);
      try { this._writeIndex(rebuilt); } catch { /* rebuilt again next time */ }
      return rebuilt;
    }
  }

  _rebuildIndexIfTasksExist({ write = true } = {}) {
    let files = [];
    try { files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith(".json")); } catch { return []; }
    const entries = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const task = this._readTaskFile(id, { quarantine: true });
      if (task) entries.push({ id: task.id, title: task.title, objective: task.objective, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt });
    }
    entries.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    if (write && entries.length) {
      try { this._writeIndex(entries); } catch { /* index is rebuilt again next time */ }
    }
    return entries;
  }

  /** Read + validate one task file. Corrupt files are quarantined, never trusted. */
  _readTaskFile(id, { quarantine = true } = {}) {
    const file = this._taskPath(id);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      if (quarantine) this._quarantine(file, `invalid JSON: ${e.message}`);
      throw new StoredRecordCorruptError(id, "invalid JSON");
    }
    const problems = validateTaskRecord(parsed, id);
    if (problems.length) {
      if (quarantine) this._quarantine(file, problems.join("; "));
      throw new StoredRecordCorruptError(id, problems[0]);
    }
    return sanitizeValue(parsed);
  }

  _writeIndex(index) {
    writeJsonAtomic(this.indexPath, index.slice(0, 500));
  }

  create(task) {
    const now = new Date().toISOString();
    const record = {
      ...task,
      createdAt: task.createdAt || now,
      updatedAt: now,
    };
    const problems = validateTaskRecord(record);
    if (problems.length) throw Object.assign(new Error(`Invalid task record: ${problems[0]}`), { statusCode: 400 });
    this._withLock(() => {
      writeJsonAtomic(this._taskPath(record.id), sanitizeValue(record));
      const index = this._index().filter((t) => t.id !== record.id);
      index.unshift({
        id: record.id,
        title: sanitizeValue(record.title),
        objective: sanitizeValue(record.objective),
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      this._writeIndex(index);
    });
    return record;
  }

  get(id) {
    return this._readTaskFile(id);
  }

  save(task) {
    const record = { ...task, updatedAt: new Date().toISOString() };
    const problems = validateTaskRecord(record);
    if (problems.length) throw Object.assign(new Error(`Invalid task record: ${problems[0]}`), { statusCode: 400 });
    this._withLock(() => {
      writeJsonAtomic(this._taskPath(record.id), sanitizeValue(record));
      const index = this._index();
      const entry = index.find((t) => t.id === record.id);
      if (entry) {
        entry.status = record.status;
        entry.title = sanitizeValue(record.title);
        entry.objective = sanitizeValue(record.objective);
        entry.updatedAt = record.updatedAt;
      } else {
        index.unshift({
          id: record.id,
          title: sanitizeValue(record.title),
          objective: sanitizeValue(record.objective),
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
      this._writeIndex(index);
    });
    return record;
  }

  list() {
    const index = this._index();
    const out = [];
    for (const entry of index) {
      try {
        const full = this.get(entry.id);
        if (full) out.push(full);
      } catch (e) {
        if (!(e instanceof StoredRecordCorruptError)) throw e; // corrupt record: quarantined and skipped
      }
    }
    return out;
  }

  /**
   * Restart recovery: side effects recorded during a previous process are
   * uncertain, so running tasks move to `paused` with a recovery note and are
   * never automatically resumed. Steps caught mid-flight become `pending`
   * again but carry an `uncertainSideEffects` marker so the orchestrator will
   * not blindly repeat them without operator input.
   */
  recoverInterrupted() {
    const recovered = [];
    for (const task of this.list()) {
      if (!["running", "planning", "waiting_approval"].includes(task.status)) continue;
      task.recovery = {
        interruptedAt: task.updatedAt,
        recoveredAt: new Date().toISOString(),
        note:
          "Execution was interrupted by a server restart. Side effects from the " +
          "in-flight step are uncertain and were NOT automatically repeated. " +
          "Review the events, then resume manually.",
      };
      for (const step of task.steps ?? []) {
        if (step.status === "running") {
          step.status = "pending";
          step.uncertainSideEffects = true;
          step.recoveryNote = "Step was mid-flight at restart; reconcile its outcome before any retry.";
        } else if (step.status === "waiting_approval") {
          step.status = "pending";
          step.approval = null;
          step.recoveryNote = "Approval was interrupted by restart and must be requested again.";
        }
      }
      task.approvals = (task.approvals ?? []).filter((a) => a.decision === "refused");
      task.status = "paused";
      if (Array.isArray(task.events)) {
        task.events.push({
          seq: task.events.length + 1,
          at: new Date().toISOString(),
          type: "recovery",
          message: "Task moved to paused after server restart; manual resume required.",
        });
        if (task.events.length > this.eventsCap) {
          task.events.splice(0, task.events.length - this.eventsCap);
        }
      }
      this.save(task);
      recovered.push(task);
    }
    return recovered;
  }

  appendEvent(id, event) {
    const task = this.get(id);
    if (!task) return null;
    if (!Array.isArray(task.events)) task.events = [];
    const seq = (task.events[task.events.length - 1]?.seq ?? 0) + 1;
    const record = { seq, at: new Date().toISOString(), ...event };
    task.events.push(record);
    if (task.events.length > this.eventsCap) {
      task.events.splice(0, task.events.length - this.eventsCap);
    }
    this.save(task);
    return record;
  }
}
