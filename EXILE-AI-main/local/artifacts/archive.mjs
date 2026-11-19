/**
 * ZIP archives and generated project packages.
 *
 * Input: { files: [{ path, content } | { path, base64 }], projectName? }
 * Every path is validated (no traversal, absolute, drive or reserved names), duplicates are
 * rejected, and sizes are capped. Nothing is ever executed.
 */
import { invalid } from "./errors.mjs";
import { makeZip, readZipChecked, readCentralDirectory, validateEntryPath, ZIP_LIMITS } from "./zip-utils.mjs";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export function prepareArchive(spec) {
  if (!Array.isArray(spec.files) || !spec.files.length) throw invalid("Provide a non-empty `files` array.");
  if (spec.files.length > MAX_FILES) throw invalid(`At most ${MAX_FILES} files are supported.`);
  const root = spec.projectName ? String(spec.projectName).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 60) : "";
  const seen = new Set();
  let total = 0;
  const entries = spec.files.map((f, i) => {
    if (!f || typeof f !== "object") throw invalid(`File ${i + 1} must be an object.`);
    let path;
    try { path = validateEntryPath(f.path); } catch (error) { throw invalid(error.message); }
    const lower = path.toLowerCase();
    if (seen.has(lower)) throw invalid(`Duplicate file path: ${path}`);
    seen.add(lower);
    let data;
    if (typeof f.content === "string") data = Buffer.from(f.content, "utf8");
    else if (typeof f.base64 === "string") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)) throw invalid(`File ${path} has invalid base64.`);
      data = Buffer.from(f.base64, "base64");
    } else if (Buffer.isBuffer(f.data)) data = f.data;
    else throw invalid(`File ${path} needs \`content\` or \`base64\`.`);
    if (data.length > MAX_FILE_BYTES) throw invalid(`File ${path} is larger than ${MAX_FILE_BYTES / 1048576} MB.`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw invalid(`The files total more than ${MAX_TOTAL_BYTES / 1048576} MB.`);
    return { path: root ? `${root}/${path}` : path, data };
  });
  return { entries, root };
}

async function generateZip(spec) {
  const { entries, root } = prepareArchive(spec);
  const buffer = makeZip(entries);
  return { buffer, metadata: { entries: entries.length, root: root || null, paths: entries.map((e) => e.path).slice(0, 200) } };
}

async function validateZip(buffer, spec) {
  const checks = [];
  const failures = [];
  let files;
  try {
    files = readZipChecked(buffer);
    checks.push(`Archive extracts and every entry passes its CRC-32 (${files.size} files)`);
  } catch (error) {
    return { checks, failures: [`Archive is invalid: ${error.message}`], skipped: [] };
  }
  let unsafe = 0;
  for (const name of files.keys()) {
    try { validateEntryPath(name); } catch { unsafe++; }
  }
  if (unsafe) failures.push(`${unsafe} entr${unsafe === 1 ? "y has" : "ies have"} an unsafe path.`);
  else checks.push("All entry paths are relative and safe");
  const expandedTotal = readCentralDirectory(buffer).reduce((n, e) => n + e.size, 0);
  if (expandedTotal > ZIP_LIMITS.maxExpandedBytes) failures.push("Archive expands beyond the allowed size.");
  if (spec?.files) {
    try {
      const { entries } = prepareArchive(spec);
      const missing = entries.filter((e) => !files.has(e.path) || Buffer.compare(Buffer.from(files.get(e.path)), e.data) !== 0);
      if (missing.length) failures.push(`${missing.length} expected file${missing.length === 1 ? "" : "s"} missing or different after extraction.`);
      else checks.push("Extracted contents are identical to the requested files");
      if (files.size !== entries.length) failures.push(`Expected ${entries.length} entries but found ${files.size}.`);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return { checks, failures, skipped: [] };
}

export const archiveGenerators = { zip: { generate: generateZip, validate: validateZip } };
