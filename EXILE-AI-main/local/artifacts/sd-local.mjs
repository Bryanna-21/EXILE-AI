/**
 * Optional AI image generation through the local stable-diffusion.cpp install that the
 * existing /exile-image route already uses. No cloud call is made. Basic image creation
 * never depends on this: SVG and procedural graphics are always available.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runTool } from "./tools.mjs";
import { invalid, unavailable, generationFailed } from "./errors.mjs";

export function sdPaths() {
  const root = path.join(os.homedir(), "AI-Models", "stable-diffusion.cpp");
  return {
    root,
    executable: process.env.EXILE_SD_CLI || path.join(root, "runtime", "sd-cli.exe"),
    model: process.env.EXILE_SD_MODEL || path.join(root, "models", "stable-diffusion-v1-5-Q4_0.gguf"),
  };
}

export function sdAvailable() {
  const p = sdPaths();
  try {
    return fs.statSync(p.executable).isFile() && fs.statSync(p.model).isFile();
  } catch {
    return false;
  }
}

export async function generateWithLocalSd({ prompt, width = 512, height = 512, steps = 8, seed }, { tempDir }) {
  const text = String(prompt ?? "").trim();
  if (!text) throw invalid("An image prompt is required.");
  if (text.length > 2000) throw invalid("Image prompts must be 2,000 characters or fewer.");
  if (![256, 512].includes(Number(width)) || ![256, 512].includes(Number(height))) throw invalid("Local image generation supports 256 or 512 pixel sides.");
  if (!sdAvailable()) throw unavailable("The local Stable Diffusion executable or model was not found, so AI image generation is unavailable. SVG and procedural images still work.");
  const p = sdPaths();
  const out = path.join(tempDir, `sd-${crypto.randomBytes(4).toString("hex")}.png`);
  const s = Math.max(2, Math.min(20, Math.floor(Number(steps) || 8)));
  const run = await runTool(p.executable, [
    "--model", p.model, "--prompt", text, "--output", out, "--steps", String(s),
    "--seed", String(seed ?? crypto.randomInt(0, 2147483647)), "--width", String(width), "--height", String(height),
  ], { cwd: path.dirname(p.executable), timeoutMs: 300_000 });
  if (run.code !== 0) throw generationFailed(`Local image generation failed: ${run.stderr.trim().slice(-160)}`);
  try {
    return await fsp.readFile(out);
  } catch {
    throw generationFailed("Local image generation produced no file.");
  }
}
