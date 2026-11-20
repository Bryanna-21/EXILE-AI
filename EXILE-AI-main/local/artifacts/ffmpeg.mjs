/**
 * Thin, safe wrappers around FFmpeg / FFprobe used by the audio and video pipelines.
 * All paths passed in must already live inside the job's temp directory.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { findTool, runTool } from "./tools.mjs";
import { ArtifactError, unavailable, generationFailed } from "./errors.mjs";

export const MEDIA_LIMITS = Object.freeze({
  maxAudioSeconds: 1800,
  maxVideoSeconds: 300,
  maxWidth: 1920,
  maxHeight: 1080,
  maxScenes: 60,
  maxFps: 60,
  timeoutMs: 180_000,
});

export function requireFfmpeg() {
  const bin = findTool("ffmpeg");
  if (!bin) throw unavailable("FFmpeg is not installed, so this media operation is unavailable. Install FFmpeg or set EXILE_FFMPEG to its path.");
  return bin;
}

export function ffmpegAvailable() {
  return !!findTool("ffmpeg") && !!findTool("ffprobe");
}

/** Run ffmpeg and throw a GENERATION_FAILURE with the (redacted) tail of stderr on error. */
export async function ffmpeg(args, { cwd, timeoutMs = MEDIA_LIMITS.timeoutMs } = {}) {
  const bin = requireFfmpeg();
  const run = await runTool(bin, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", ...args], { cwd, timeoutMs });
  if (run.code !== 0) {
    const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw generationFailed(`FFmpeg failed: ${tail || `exit ${run.code}`}`);
  }
  return run;
}

export async function probe(file) {
  const bin = findTool("ffprobe");
  if (!bin) throw unavailable("FFprobe is not installed, so media files cannot be inspected.");
  const run = await runTool(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 30_000 });
  if (run.code !== 0) throw generationFailed(`FFprobe could not read the file: ${run.stderr.trim().slice(0, 200)}`);
  try {
    const info = JSON.parse(run.stdout);
    return {
      format: info.format?.format_name || "",
      duration: Number(info.format?.duration) || 0,
      streams: (info.streams || []).map((s) => ({
        type: s.codec_type, codec: s.codec_name, width: s.width, height: s.height,
        duration: Number(s.duration) || 0, channels: s.channels, sampleRate: Number(s.sample_rate) || undefined,
        fps: s.avg_frame_rate && s.avg_frame_rate.includes("/") ? (() => { const [a, b] = s.avg_frame_rate.split("/").map(Number); return b ? a / b : 0; })() : 0,
        nbFrames: Number(s.nb_frames) || undefined,
      })),
    };
  } catch {
    throw generationFailed("FFprobe returned unreadable output.");
  }
}

/** Decode every frame/sample and report decoder errors. Returns the list of error lines. */
export async function fullDecodeErrors(file) {
  const bin = requireFfmpeg();
  const run = await runTool(bin, ["-nostdin", "-v", "error", "-i", file, "-f", "null", "-"], { timeoutMs: MEDIA_LIMITS.timeoutMs });
  const lines = run.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (run.code !== 0 && !lines.length) lines.push(`decoder exited with code ${run.code}`);
  return lines.slice(0, 5);
}

/** Mean volume in dB (null when it cannot be measured). */
export async function meanVolumeDb(file) {
  const bin = requireFfmpeg();
  const run = await runTool(bin, ["-nostdin", "-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { timeoutMs: MEDIA_LIMITS.timeoutMs });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(run.stderr);
  if (!m) return null;
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

export async function withFiles(tempDir, files, fn) {
  const dir = path.join(tempDir, `m-${crypto.randomBytes(4).toString("hex")}`);
  await fsp.mkdir(dir, { recursive: true });
  const paths = {};
  try {
    for (const [name, buf] of Object.entries(files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ArtifactError("INVALID_INPUT", "Invalid temp file name.");
      paths[name] = path.join(dir, name);
      await fsp.writeFile(paths[name], buf);
    }
    return await fn({ dir, paths, file: (n) => path.join(dir, n) });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** FFmpeg filter-graph strings must not carry arbitrary user text: only numbers go in. */
export const num = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ArtifactError("INVALID_INPUT", `${name} must be a number between ${min} and ${max}.`);
  return n;
};

export const fmtSec = (n) => (Math.round(n * 1000) / 1000).toString();
