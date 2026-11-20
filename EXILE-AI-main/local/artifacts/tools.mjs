/**
 * Discovery and safe execution of local command-line media tools (FFmpeg, FFprobe,
 * LibreOffice, pdftoppm, TTS and speech engines).
 *
 * - Tools are located once per process (PATH or explicit EXILE_* override) and cached.
 * - Commands are run with argument arrays, never through a shell.
 * - Every run has a timeout and an output cap; the environment is minimal.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ArtifactError } from "./errors.mjs";

const IS_WIN = process.platform === "win32";

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names, pathEnv = process.env.PATH || "") {
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + (IS_WIN && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""));
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

const TOOL_DEFS = {
  ffmpeg: { names: ["ffmpeg"], env: "EXILE_FFMPEG" },
  ffprobe: { names: ["ffprobe"], env: "EXILE_FFPROBE" },
  soffice: { names: ["soffice", "libreoffice"], env: "EXILE_SOFFICE" },
  pdftoppm: { names: ["pdftoppm"], env: "EXILE_PDFTOPPM" },
  espeak: { names: ["espeak-ng", "espeak"], env: "EXILE_ESPEAK" },
  say: { names: ["say"], env: "EXILE_SAY" },
  powershell: { names: ["powershell", "pwsh"], env: "EXILE_POWERSHELL" },
  whisper: { names: ["whisper-cli", "whisper-cpp", "main"], env: "EXILE_WHISPER_CLI" },
};

const cache = new Map();

/** Find a tool. `pathEnv` overrides PATH (used by tests with fake tools). */
export function findTool(name, { pathEnv, refresh = false } = {}) {
  const def = TOOL_DEFS[name];
  if (!def) return null;
  const cacheKey = `${name}|${pathEnv || ""}`;
  if (!refresh && cache.has(cacheKey)) return cache.get(cacheKey);
  const explicit = process.env[def.env];
  let found = null;
  if (explicit && isExecutable(explicit)) found = explicit;
  else if (name === "whisper" && !explicit) found = null; // generic names like "main" are too ambiguous
  else found = findOnPath(def.names, pathEnv);
  cache.set(cacheKey, found);
  return found;
}

export function clearToolCache() {
  cache.clear();
}

/**
 * Run a command with a timeout. Resolves { code, stdout, stderr }. Never throws on a
 * non-zero exit; throws ArtifactError TIMEOUT when the time limit is hit.
 */
export function runTool(file, args, { timeoutMs = 60_000, cwd, maxOutputBytes = 8 * 1024 * 1024, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: env ?? minimalEnv(),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const cap = (prev, chunk) => (prev.length >= maxOutputBytes ? prev : Buffer.concat([prev, chunk]).subarray(0, maxOutputBytes));
    child.stdout.on("data", (c) => { stdout = cap(stdout, c); });
    child.stderr.on("data", (c) => { stderr = cap(stderr, c); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ArtifactError("ENGINE_UNAVAILABLE", `Could not start ${path.basename(file)}: ${error.code || error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new ArtifactError("TIMEOUT", `${path.basename(file)} exceeded the ${Math.round(timeoutMs / 1000)}s time limit.`));
      resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), stdoutBuffer: stdout });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Environment for child tools: no credentials, no inherited secrets. */
export function minimalEnv() {
  const keep = ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "FONTCONFIG_PATH"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function toolVersionSync(file, args = ["-version"]) {
  try {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true, env: minimalEnv() });
    return (r.stdout || r.stderr || "").split("\n")[0].slice(0, 160);
  } catch {
    return "";
  }
}

/** A font file usable by FFmpeg drawtext, or null (callers then fall back to soft subtitles). */
export function findCaptionFont() {
  const candidates = [
    process.env.EXILE_CAPTION_FONT,
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch { /* keep looking */ }
  }
  return null;
}
