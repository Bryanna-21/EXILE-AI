/**
 * Controlled artifact storage.
 *
 * Layout (all under rootDir, which the caller controls):
 *   items/<artifactId>/meta.json      metadata, version list, delivery records
 *   items/<artifactId>/v<N>.<ext>     one immutable file per version
 *   tmp/<jobId>/                      per-job scratch space, always removed after the job
 *   audit.log                         JSON lines; contains no file contents or secrets
 *
 * Clients only ever see artifact ids. File names inside the store are derived from a
 * validated id, an integer version and an extension from the format registry, so no
 * client-supplied string is ever used as a path.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { FORMATS, getFormat } from "./formats.mjs";
import { ArtifactError, redact } from "./errors.mjs";

const ID_RE = /^art_[0-9a-f]{24}$/;
const JOB_RE = /^job_[0-9a-f]{16}$/;
const MAX_VERSIONS = 100;
const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export const isArtifactId = (value) => typeof value === "string" && ID_RE.test(value);
export const newArtifactId = () => `art_${crypto.randomBytes(12).toString("hex")}`;
export const newJobId = () => `job_${crypto.randomBytes(8).toString("hex")}`;

export class ArtifactStore {
  constructor({ rootDir, maxTotalBytes = 5 * 1024 ** 3, now = () => Date.now() }) {
    if (!rootDir) throw new Error("ArtifactStore requires rootDir.");
    this.rootDir = path.resolve(rootDir);
    this.itemsDir = path.join(this.rootDir, "items");
    this.tmpDir = path.join(this.rootDir, "tmp");
    this.auditFile = path.join(this.rootDir, "audit.log");
    this.maxTotalBytes = maxTotalBytes;
    this.now = now;
    this.locks = new Map();
    this.index = new Map();
    this.ready = null;
  }

  init() {
    if (!this.ready) {
      this.ready = (async () => {
        await fsp.mkdir(this.itemsDir, { recursive: true, mode: 0o700 });
        await fsp.mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
        await this.#purgeStaleTemp();
        for (const entry of await fsp.readdir(this.itemsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !isArtifactId(entry.name)) continue;
          try {
            const meta = JSON.parse(await fsp.readFile(path.join(this.itemsDir, entry.name, "meta.json"), "utf8"));
            if (meta?.id === entry.name) this.index.set(meta.id, meta);
          } catch { /* a damaged item is skipped, never served */ }
        }
      })();
    }
    return this.ready;
  }

  // ---- path helpers: the only place file paths are built ----
  #itemDir(id) {
    if (!isArtifactId(id)) throw new ArtifactError("INVALID_INPUT", "Invalid artifact id.");
    return this.#inside(this.itemsDir, id);
  }

  #versionFile(id, version, ext) {
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSIONS) {
      throw new ArtifactError("INVALID_INPUT", "Invalid artifact version.");
    }
    if (!getFormat(ext)) throw new ArtifactError("INVALID_INPUT", "Invalid artifact extension.");
    return this.#inside(this.#itemDir(id), `v${version}.${getFormat(ext).ext}`);
  }

  #inside(base, child) {
    const full = path.resolve(base, child);
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactError("FORBIDDEN", "Path escapes the artifact store.");
    }
    return full;
  }

  async #withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    const chain = prev.then(() => next);
    this.locks.set(id, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }

  async #writeAtomic(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.part`;
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async #writeMeta(meta) {
    await this.#writeAtomic(path.join(this.#itemDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2));
    this.index.set(meta.id, meta);
  }

  totalBytes() {
    let total = 0;
    for (const meta of this.index.values()) for (const v of meta.versions) total += v.sizeBytes;
    return total;
  }

  // ---- artifacts ----
  async create({ name, format, buffer, validation, source, metadata, derivedFrom }) {
    await this.init();
    const fmt = getFormat(format);
    if (!fmt) throw new ArtifactError("INVALID_INPUT", "Unknown format.");
    this.#assertSize(fmt, buffer);
    const id = newArtifactId();
    const createdAt = this.now();
    const meta = {
      id,
      name: sanitizeName(name, fmt.ext),
      format: fmt.id,
      ext: fmt.ext,
      mime: fmt.mime,
      kind: fmt.kind,
      createdAt,
      updatedAt: createdAt,
      currentVersion: 1,
      versions: [],
      deliveries: [],
      ...(derivedFrom ? { derivedFrom } : {}),
    };
    await fsp.mkdir(this.#itemDir(id), { recursive: true, mode: 0o700 });
    try {
      await this.#writeAtomic(this.#versionFile(id, 1, fmt.ext), buffer);
      meta.versions.push(versionRecord(1, buffer, createdAt, validation, source, metadata));
      await this.#writeMeta(meta);
    } catch (error) {
      await fsp.rm(this.#itemDir(id), { recursive: true, force: true });
      this.index.delete(id);
      throw error;
    }
    await this.audit("artifact.created", { artifactId: id, format: fmt.id, sizeBytes: buffer.length });
    return structuredClone(meta);
  }

  async addVersion(id, { buffer, validation, source, metadata, expectedVersion }) {
    await this.init();
    return this.#withLock(id, async () => {
      const meta = this.#mustGet(id);
      if (expectedVersion !== undefined && meta.currentVersion !== expectedVersion) {
        throw new ArtifactError("CONFLICT", "The artifact changed while this edit was being generated. Reopen the latest version and try again.");
      }
      if (meta.versions.length >= MAX_VERSIONS) throw new ArtifactError("TOO_LARGE", `An artifact can keep at most ${MAX_VERSIONS} versions.`);
      const fmt = getFormat(meta.format);
      this.#assertSize(fmt, buffer);
      const version = meta.versions[meta.versions.length - 1].version + 1;
      const createdAt = this.now();
      await this.#writeAtomic(this.#versionFile(id, version, fmt.ext), buffer);
      const next = {
        ...meta,
        updatedAt: createdAt,
        currentVersion: version,
        versions: [...meta.versions, versionRecord(version, buffer, createdAt, validation, source, metadata)],
      };
      await this.#writeMeta(next);
      await this.audit("artifact.versioned", { artifactId: id, version, sizeBytes: buffer.length });
      return structuredClone(next);
    });
  }

  #assertSize(fmt, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ArtifactError("GENERATION_FAILURE", "The generated file is empty.");
    }
    if (buffer.length > fmt.maxBytes) {
      throw new ArtifactError("TOO_LARGE", `The ${fmt.label} is ${(buffer.length / 1048576).toFixed(1)} MB; the limit for this format is ${Math.round(fmt.maxBytes / 1048576)} MB.`);
    }
    if (this.totalBytes() + buffer.length > this.maxTotalBytes) {
      throw new ArtifactError("TOO_LARGE", "The artifact store is full. Delete some artifacts first.");
    }
  }

  #mustGet(id) {
    if (!isArtifactId(id)) throw new ArtifactError("INVALID_INPUT", "Invalid artifact id.");
    const meta = this.index.get(id);
    if (!meta) throw new ArtifactError("NOT_FOUND", "Artifact not found.");
    return meta;
  }

  async get(id) {
    await this.init();
    return structuredClone(this.#mustGet(id));
  }

  async list({ kind, limit = 200 } = {}) {
    await this.init();
    return [...this.index.values()]
      .filter((m) => !kind || m.kind === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((m) => structuredClone(m));
  }

  async readVersion(id, version) {
    await this.init();
    const meta = this.#mustGet(id);
    const v = version === undefined || version === null ? meta.currentVersion : Number(version);
    const record = meta.versions.find((x) => x.version === v);
    if (!record) throw new ArtifactError("NOT_FOUND", "Artifact version not found.");
    const buffer = await fsp.readFile(this.#versionFile(id, v, meta.ext));
    const sha = crypto.createHash("sha256").update(buffer).digest("hex");
    if (sha !== record.sha256) {
      await this.audit("artifact.integrity_failure", { artifactId: id, version: v });
      throw new ArtifactError("VALIDATION_FAILURE", "The stored file no longer matches its recorded checksum.");
    }
    return { meta: structuredClone(meta), record: structuredClone(record), buffer };
  }

  async delete(id) {
    await this.init();
    return this.#withLock(id, async () => {
      this.#mustGet(id);
      await fsp.rm(this.#itemDir(id), { recursive: true, force: true });
      this.index.delete(id);
      await this.audit("artifact.deleted", { artifactId: id });
      return true;
    });
  }

  // ---- delivery records ----
  async addDelivery(id, { channel, target, state = "queued", note }) {
    await this.init();
    return this.#withLock(id, async () => {
      const meta = this.#mustGet(id);
      const record = {
        id: `del_${crypto.randomBytes(6).toString("hex")}`,
        channel,
        target: maskTarget(target),
        state,
        queuedAt: this.now(),
        ...(note ? { note: redact(note) } : {}),
      };
      const next = { ...meta, deliveries: [...meta.deliveries, record].slice(-50) };
      await this.#writeMeta(next);
      await this.audit("delivery.queued", { artifactId: id, deliveryId: record.id, channel });
      return structuredClone(record);
    });
  }

  async updateDelivery(id, deliveryId, patch) {
    await this.init();
    return this.#withLock(id, async () => {
      const meta = this.#mustGet(id);
      const existing = meta.deliveries.find((d) => d.id === deliveryId);
      if (!existing) throw new ArtifactError("NOT_FOUND", "Delivery record not found.");
      // Terminal states are final: a sent record can never be rewritten as failed, or vice versa.
      if (existing.state === "sent" || existing.state === "failed") {
        throw new ArtifactError("FORBIDDEN", `Delivery is already ${existing.state}.`);
      }
      const record = { ...existing, state: patch.state, finishedAt: this.now(), ...(patch.error ? { error: redact(patch.error) } : {}) };
      const next = { ...meta, deliveries: meta.deliveries.map((d) => (d.id === deliveryId ? record : d)) };
      await this.#writeMeta(next);
      await this.audit(`delivery.${patch.state}`, { artifactId: id, deliveryId });
      return structuredClone(record);
    });
  }

  // ---- temp space ----
  async makeTempDir(jobId) {
    await this.init();
    if (!JOB_RE.test(jobId)) throw new ArtifactError("INVALID_INPUT", "Invalid job id.");
    const dir = this.#inside(this.tmpDir, jobId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async cleanupTemp(dir) {
    if (!dir) return;
    const full = path.resolve(dir);
    const rel = path.relative(this.tmpDir, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // never delete outside tmp
    await fsp.rm(full, { recursive: true, force: true });
  }

  async #purgeStaleTemp() {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const entry of await fsp.readdir(this.tmpDir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(this.tmpDir, entry.name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  async tempDirCount() {
    await this.init();
    return (await fsp.readdir(this.tmpDir)).length;
  }

  // ---- audit ----
  async audit(event, data = {}) {
    try {
      await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      try {
        const st = await fsp.stat(this.auditFile);
        if (st.size > AUDIT_ROTATE_BYTES) await fsp.rename(this.auditFile, `${this.auditFile}.1`);
      } catch { /* no file yet */ }
      const safe = {};
      for (const [k, v] of Object.entries(data)) safe[k] = typeof v === "string" ? redact(v) : v;
      await fsp.appendFile(this.auditFile, JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...safe }) + "\n", { mode: 0o600 });
    } catch { /* auditing must never break the operation it records */ }
  }

  async readAudit(limit = 200) {
    try {
      const lines = (await fsp.readFile(this.auditFile, "utf8")).trim().split("\n").slice(-limit);
      return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

function versionRecord(version, buffer, createdAt, validation, source, metadata) {
  return {
    version,
    sizeBytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    createdAt,
    validation: validation ?? { passed: false, checks: [], failures: ["not validated"] },
    source: source ?? {},
    metadata: metadata ?? {},
  };
}

/** A display-safe file name. Never contains path separators or control characters. */
export function sanitizeName(name, ext) {
  let base = String(name || "").normalize("NFKC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
  base = base.replace(/^\.+/, "").replace(/\.+$/, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (!base || reserved.test(base)) base = "exile-artifact";
  const suffix = `.${ext}`;
  if (base.toLowerCase().endsWith(suffix)) base = base.slice(0, -suffix.length);
  return `${base.slice(0, 120)}${suffix}`;
}

function maskTarget(target) {
  const s = String(target || "");
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export { FORMATS };
