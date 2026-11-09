"use strict";
/**
 * Validation rules for imported native applications.
 *
 * Everything here runs in the Electron MAIN process. The renderer is never
 * trusted: it cannot supply an executable path at launch time (launch is by
 * stored id) and every value it does supply (name, category, arguments) is
 * validated here before it is stored or used.
 *
 * Rules are keyed by platform. Windows is the supported release target. Linux
 * is implemented only for manual import/launch so the pipeline can be tested
 * against real processes during development; it is not a release target.
 * Anything else is reported as unsupported rather than guessed at.
 *
 * Path syntax checks are pure (they take the platform explicitly and use
 * path.win32 / path.posix), so the Windows rules can be unit-tested on any OS.
 */

const nodePath = require("node:path");

const LIMITS = Object.freeze({
  maxApps: 200,
  nameMax: 80,
  categoryMax: 40,
  pathMax: 4096,
  argCountMax: 32,
  argLenMax: 1024,
  argsTotalMax: 8192,
  historyMax: 100,
});

/**
 * Programs that interpret arbitrary code from their arguments. They may be
 * imported and opened with NO arguments (an interactive shell is a normal thing
 * to launch), but never with arguments, so a compromised renderer cannot turn
 * the launcher into a command runner. This is defence in depth, not a complete
 * list: any program can have dangerous arguments, which is why changing
 * arguments also needs native confirmation (see service.cjs).
 */
const INTERPRETERS = Object.freeze({
  win32: new Set([
    "cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "wscript.exe",
    "cscript.exe", "mshta.exe", "rundll32.exe", "regsvr32.exe", "msiexec.exe",
    "wsl.exe", "bash.exe", "sh.exe", "certutil.exe", "bitsadmin.exe", "reg.exe",
    "regedit.exe", "schtasks.exe", "sc.exe", "net.exe", "net1.exe", "at.exe",
    "forfiles.exe", "installutil.exe", "regasm.exe", "regsvcs.exe", "msbuild.exe",
    "msxsl.exe", "odbcconf.exe", "pcalua.exe", "scriptrunner.exe", "wmic.exe",
    "python.exe", "pythonw.exe", "node.exe", "perl.exe", "ruby.exe", "java.exe",
    "javaw.exe", "curl.exe", "ssh.exe", "scp.exe", "ftp.exe", "tftp.exe",
  ]),
  linux: new Set([
    "sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "env", "xargs",
    "python", "python3", "perl", "ruby", "node", "php", "lua", "awk", "gawk",
    "sudo", "su", "doas", "nohup", "timeout", "nice", "setsid", "busybox",
    "curl", "wget", "nc", "ncat", "ssh", "scp", "find", "tclsh", "expect",
  ]),
});

const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const PLATFORM_SUPPORT = Object.freeze({
  win32: Object.freeze({
    supported: true,
    discovery: true,
    manualImport: true,
    launch: true,
    shortcutImport: true,
    experimental: false,
    executableDescription: ".exe programs",
  }),
  linux: Object.freeze({
    supported: true,
    discovery: false,
    manualImport: true,
    launch: true,
    shortcutImport: false,
    experimental: true,
    executableDescription: "executable files",
  }),
});

const UNSUPPORTED = Object.freeze({
  supported: false,
  discovery: false,
  manualImport: false,
  launch: false,
  shortcutImport: false,
  experimental: false,
  executableDescription: "none",
});

function platformSupport(platform) {
  return PLATFORM_SUPPORT[platform] ?? UNSUPPORTED;
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// Control characters (C0 range and DEL) are never valid in names, paths or arguments.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/* ----------------------------- executable path ---------------------------- */

/**
 * Syntax-only validation of an executable path for a platform.
 * Returns { ok: true, path } with the normalised path, or { ok: false, error }.
 * It does not touch the disk.
 */
function validateExecutablePathSyntax(input, platform) {
  const support = platformSupport(platform);
  if (!support.supported) {
    return fail("unsupported-platform", "Native application import is not supported on this operating system.");
  }
  if (typeof input !== "string" || input.length === 0) {
    return fail("invalid-path", "An executable path is required.");
  }
  if (input.length > LIMITS.pathMax) {
    return fail("invalid-path", "The executable path is too long.");
  }
  if (CONTROL_CHARS.test(input)) {
    return fail("invalid-path", "The executable path contains control characters.");
  }

  if (platform === "win32") return validateWindowsPath(input);
  return validatePosixPath(input);
}

function validateWindowsPath(input) {
  const p = nodePath.win32;

  // Reject network (UNC) paths and device / extended-length namespaces outright.
  if (/^[\\/]{2}/.test(input)) {
    return fail("invalid-path", "Network (UNC) and device paths are not supported. Choose a program on a local drive.");
  }
  if (!/^[A-Za-z]:[\\/]/.test(input)) {
    return fail("invalid-path", "The executable path must be absolute and start with a drive letter, for example C:\\Program Files\\App\\app.exe.");
  }

  const rest = input.slice(3);
  // After the drive prefix no ':' is valid; this blocks NTFS alternate data streams (file.exe:stream).
  if (rest.includes(":")) {
    return fail("invalid-path", "The executable path contains an invalid ':' character.");
  }
  if (/[<>"|?*]/.test(input)) {
    return fail("invalid-path", "The executable path contains wildcard or reserved characters.");
  }

  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) {
    return fail("invalid-path", "The path does not name a file.");
  }
  if (segments.some((s) => s === "." || s === "..")) {
    return fail("invalid-path", "Relative path segments ('.' or '..') are not allowed.");
  }
  if (segments.some((s) => /[. ]$/.test(s))) {
    return fail("invalid-path", "Path segments may not end with a space or a dot.");
  }

  const normalized = p.normalize(input);
  const base = p.basename(normalized);
  const ext = p.extname(base).toLowerCase();
  if (ext !== ".exe") {
    return fail(
      "invalid-path",
      ext
        ? `Only .exe programs can be imported (this is a ${ext} file). Scripts, installers and batch files are not allowed.`
        : "Only .exe programs can be imported.",
    );
  }
  const stem = base.slice(0, -ext.length).toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    return fail("invalid-path", "That file name is reserved by Windows.");
  }
  return { ok: true, path: normalized };
}

function validatePosixPath(input) {
  const p = nodePath.posix;
  if (!p.isAbsolute(input)) {
    return fail("invalid-path", "The executable path must be absolute.");
  }
  const segments = input.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return fail("invalid-path", "The path does not name a file.");
  if (segments.some((s) => s === "." || s === "..")) {
    return fail("invalid-path", "Relative path segments ('.' or '..') are not allowed.");
  }
  return { ok: true, path: p.normalize(input) };
}

/**
 * Check the file on disk. Returns
 *   { ok: true, path, realPath, mtimeMs, size }
 * or { ok: false, status, error } where status is one of
 *   "missing" | "inaccessible" | "invalid".
 * `fsImpl` is injected so tests can use a fake filesystem.
 */
function inspectExecutable(input, platform, fsImpl) {
  const syntax = validateExecutablePathSyntax(input, platform);
  if (!syntax.ok) return { ok: false, status: "invalid", error: syntax.error };

  let realPath;
  let stat;
  try {
    realPath = fsImpl.realpathSync.native
      ? fsImpl.realpathSync.native(syntax.path)
      : fsImpl.realpathSync(syntax.path);
    stat = fsImpl.statSync(realPath);
  } catch (error) {
    const code = error && error.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: "missing", error: { code: "missing", message: "The executable no longer exists at this location." } };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, status: "inaccessible", error: { code: "inaccessible", message: "EXILE does not have permission to read this executable." } };
    }
    return { ok: false, status: "inaccessible", error: { code: "inaccessible", message: `The executable could not be checked (${code || "unknown error"}).` } };
  }

  if (!stat.isFile()) {
    return { ok: false, status: "invalid", error: { code: "invalid-path", message: "The path is not a regular file." } };
  }

  // The resolved target (after symlinks / junctions) must satisfy the same rules.
  const resolved = validateExecutablePathSyntax(realPath, platform);
  if (!resolved.ok) {
    return { ok: false, status: "invalid", error: resolved.error };
  }

  if (platform !== "win32") {
    try {
      fsImpl.accessSync(realPath, fsImpl.constants.X_OK);
    } catch {
      return { ok: false, status: "inaccessible", error: { code: "inaccessible", message: "The file is not executable." } };
    }
  }

  return { ok: true, path: syntax.path, realPath: resolved.path, mtimeMs: stat.mtimeMs, size: stat.size };
}

/** Case-insensitive on Windows, case-sensitive elsewhere. */
function pathKey(p, platform) {
  const normalized = platform === "win32" ? nodePath.win32.normalize(p) : nodePath.posix.normalize(p);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Two entries are duplicates when they launch the same program with the same arguments. */
function dedupeKey(exePath, args, platform) {
  return `${pathKey(exePath, platform)}\u0000${JSON.stringify(args)}`;
}

function isInterpreter(exePath, platform) {
  const set = INTERPRETERS[platform];
  if (!set) return false;
  const base = (platform === "win32" ? nodePath.win32 : nodePath.posix).basename(exePath).toLowerCase();
  return set.has(base);
}

/* --------------------------------- arguments ------------------------------ */

/**
 * Split a user-typed argument string into an argv array WITHOUT any shell
 * semantics. Rules (documented in the UI):
 *   - arguments are separated by whitespace
 *   - double quotes group text containing spaces; the quotes themselves are removed
 *   - there are no escape sequences (backslashes are literal, which keeps
 *     Windows paths intact) and no variable, glob or command expansion
 * Returns { ok: true, args } or { ok: false, error }.
 */
function parseArgumentString(input) {
  if (typeof input !== "string") return fail("invalid-args", "Launch arguments must be text.");
  if (input.length > LIMITS.argsTotalMax) return fail("invalid-args", "Launch arguments are too long.");
  if (CONTROL_CHARS.test(input.replace(/[\t]/g, " "))) {
    return fail("invalid-args", "Launch arguments may not contain control characters or line breaks.");
  }
  const args = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (inQuotes) return fail("invalid-args", "Launch arguments contain an unclosed double quote.");
  if (hasToken) args.push(current);
  return validateArgumentArray(args);
}

/** Validate an already-split argv array. */
function validateArgumentArray(args) {
  if (!Array.isArray(args)) return fail("invalid-args", "Launch arguments must be a list.");
  if (args.length > LIMITS.argCountMax) {
    return fail("invalid-args", `At most ${LIMITS.argCountMax} launch arguments are allowed.`);
  }
  let total = 0;
  for (const arg of args) {
    if (typeof arg !== "string") return fail("invalid-args", "Every launch argument must be text.");
    if (arg.length > LIMITS.argLenMax) {
      return fail("invalid-args", `A launch argument exceeds ${LIMITS.argLenMax} characters.`);
    }
    if (CONTROL_CHARS.test(arg)) {
      return fail("invalid-args", "Launch arguments may not contain control characters or line breaks.");
    }
    total += arg.length;
  }
  if (total > LIMITS.argsTotalMax) return fail("invalid-args", "Launch arguments are too long.");
  return { ok: true, args: [...args] };
}

/** Enforce the interpreter rule for a (program, arguments) pair. */
function validateProgramAndArgs(exePath, args, platform) {
  if (args.length > 0 && isInterpreter(exePath, platform)) {
    return fail(
      "invalid-args",
      "This program runs commands from its arguments, so it can only be added without launch arguments.",
    );
  }
  return { ok: true };
}

/* ------------------------------- text fields ------------------------------ */

function cleanText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function validateName(value) {
  if (typeof value !== "string") return fail("invalid-name", "A name is required.");
  const name = cleanText(value);
  if (!name) return fail("invalid-name", "A name is required.");
  if (name.length > LIMITS.nameMax) return fail("invalid-name", `Names are limited to ${LIMITS.nameMax} characters.`);
  return { ok: true, value: name };
}

function validateCategory(value) {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return fail("invalid-category", "The category must be text.");
  const category = cleanText(value);
  if (category.length > LIMITS.categoryMax) {
    return fail("invalid-category", `Categories are limited to ${LIMITS.categoryMax} characters.`);
  }
  return { ok: true, value: category };
}

module.exports = {
  LIMITS,
  INTERPRETERS,
  platformSupport,
  validateExecutablePathSyntax,
  inspectExecutable,
  pathKey,
  dedupeKey,
  isInterpreter,
  parseArgumentString,
  validateArgumentArray,
  validateProgramAndArgs,
  validateName,
  validateCategory,
  cleanText,
};
