/**
 * ZIP helpers shared by the Office validators and the archive generator.
 * Reading is bounded (entry count, expanded size) and every entry's CRC-32 is verified
 * against the central directory, so truncated or tampered archives are rejected.
 */
import { unzipSync, zipSync } from "fflate";
import { XMLValidator } from "fast-xml-parser";

export const ZIP_LIMITS = Object.freeze({ maxEntries: 2000, maxExpandedBytes: 400 * 1024 * 1024 });

let crcTable;
export function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parse the central directory: [{ name, crc, compressedSize, size, method }]. */
export function readCentralDirectory(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const min = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found.");
  const total = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  if (total > ZIP_LIMITS.maxEntries) throw new Error("ZIP has too many entries.");
  const entries = [];
  for (let n = 0; n < total; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) throw new Error("ZIP central directory is damaged.");
    const method = b.readUInt16LE(off + 10);
    const crc = b.readUInt32LE(off + 16);
    const compressedSize = b.readUInt32LE(off + 20);
    const size = b.readUInt32LE(off + 24);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const name = b.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, crc, compressedSize, size, method });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read a ZIP into a Map(name -> Uint8Array) with all integrity checks.
 * Throws a plain Error describing the first problem.
 */
export function readZipChecked(buf) {
  const central = readCentralDirectory(buf);
  let expanded = 0;
  for (const e of central) {
    expanded += e.size;
    if (expanded > ZIP_LIMITS.maxExpandedBytes) throw new Error("ZIP expands beyond the allowed size.");
  }
  let files;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => f.originalSize <= ZIP_LIMITS.maxExpandedBytes });
  } catch (error) {
    throw new Error(`ZIP could not be extracted: ${error.message}`);
  }
  const out = new Map();
  for (const e of central) {
    if (e.name.endsWith("/")) continue;
    const data = files[e.name];
    if (!data) throw new Error(`ZIP entry "${e.name}" is missing after extraction.`);
    if (data.length !== e.size) throw new Error(`ZIP entry "${e.name}" has the wrong size.`);
    if (crc32(data) !== e.crc) throw new Error(`ZIP entry "${e.name}" failed its CRC-32 check.`);
    out.set(e.name, data);
  }
  return out;
}

export function isWellFormedXml(text) {
  const result = XMLValidator.validate(String(text), { allowBooleanAttributes: true });
  return result === true ? null : (result?.err?.msg || "invalid XML");
}

export const utf8 = (u8) => Buffer.from(u8).toString("utf8");

/** Create a ZIP from [{ path, data: Buffer|Uint8Array }]. */
export function makeZip(entries, { level = 6 } = {}) {
  const tree = {};
  const fixedTime = new Date(2020, 0, 1).getTime();
  for (const e of entries) tree[e.path] = [new Uint8Array(e.data), { level, mtime: e.mtime ?? fixedTime }];
  return Buffer.from(zipSync(tree));
}

/** Validate an entry path for archives and project packages. Returns the normalized path. */
export function validateEntryPath(raw) {
  const p = String(raw ?? "");
  if (!p || p.length > 240) throw new Error("Archive entry path is empty or too long.");
  if (/[\u0000-\u001f]/.test(p)) throw new Error(`Archive entry path contains control characters: ${JSON.stringify(p.slice(0, 40))}`);
  if (p.includes("\\")) throw new Error(`Archive entry path must use forward slashes: ${JSON.stringify(p.slice(0, 40))}`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new Error(`Archive entry path must be relative: ${JSON.stringify(p.slice(0, 40))}`);
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) throw new Error(`Archive entry path is not allowed: ${JSON.stringify(p.slice(0, 40))}`);
  if (parts.some((s) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s))) throw new Error(`Archive entry uses a reserved name: ${JSON.stringify(p.slice(0, 40))}`);
  return p;
}
