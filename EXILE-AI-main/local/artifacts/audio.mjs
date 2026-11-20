/**
 * Audio pipeline. Three separate capabilities, per the mission:
 *   1. synthesis    - pure-JS tone / sound-effect WAV generation (always available)
 *   2. speech       - text-to-speech via a local engine (espeak-ng, macOS say, Windows SAPI)
 *                     and transcription via a local whisper.cpp build + model
 *   3. processing   - trim, convert, volume, fade, concat, mix, extraction (FFmpeg)
 * Each reports `unavailable` honestly when its engine is missing.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { invalid, unavailable, generationFailed } from "./errors.mjs";
import { findTool, runTool, minimalEnv } from "./tools.mjs";
import { ffmpeg, probe, fullDecodeErrors, meanVolumeDb, withFiles, MEDIA_LIMITS, num, fmtSec, ffmpegAvailable } from "./ffmpeg.mjs";

// ---------------------------------------------------------------- synthesis

function wavBuffer(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const PRESETS = {
  beep: [{ freq: 880, durationMs: 250, volume: 0.5 }],
  chime: [{ freq: 784, durationMs: 180, volume: 0.5 }, { freq: 1047, durationMs: 420, volume: 0.5 }],
  success: [{ freq: 523, durationMs: 140, volume: 0.5 }, { freq: 659, durationMs: 140, volume: 0.5 }, { freq: 784, durationMs: 320, volume: 0.5 }],
  error: [{ freq: 220, durationMs: 220, volume: 0.5, wave: "square" }, { freq: 165, durationMs: 380, volume: 0.5, wave: "square" }],
  click: [{ freq: 1500, durationMs: 25, volume: 0.6, wave: "square" }],
};

export function synthWav(spec) {
  const sampleRate = 44100;
  const tones = spec.preset ? PRESETS[spec.preset] : spec.tones;
  if (!tones) throw invalid(`Provide \`tones\` or a \`preset\` (${Object.keys(PRESETS).join(", ")}).`);
  if (!Array.isArray(tones) || !tones.length || tones.length > 200) throw invalid("`tones` must contain between 1 and 200 entries.");
  const chunks = [];
  let totalMs = 0;
  for (const t of tones) {
    const durationMs = num(t.durationMs, 1, 30_000, "durationMs");
    totalMs += durationMs;
    if (totalMs > 120_000) throw invalid("Synthesized audio is limited to 120 seconds.");
    const volume = num(t.volume ?? 0.5, 0, 1, "volume");
    const n = Math.round((durationMs / 1000) * sampleRate);
    const buf = new Float32Array(n);
    if (t.freq !== 0 && t.freq !== undefined) {
      const freq = num(t.freq, 20, 20_000, "freq");
      const wave = ["sine", "square", "triangle", "saw"].includes(t.wave) ? t.wave : "sine";
      const fade = Math.min(Math.round(0.01 * sampleRate), n >> 1);
      for (let i = 0; i < n; i++) {
        const ph = (i * freq) / sampleRate;
        const f = ph - Math.floor(ph);
        const v = wave === "sine" ? Math.sin(2 * Math.PI * f) : wave === "square" ? (f < 0.5 ? 1 : -1) : wave === "triangle" ? 4 * Math.abs(f - 0.5) - 1 : 2 * f - 1;
        const env = i < fade ? i / fade : i > n - fade ? (n - i) / fade : 1;
        buf[i] = v * volume * env;
      }
    } // freq 0 is silence
    chunks.push(buf);
  }
  const all = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return { buffer: wavBuffer(all, sampleRate), durationMs: totalMs };
}

// --------------------------------------------------------------- speech: TTS

export function ttsEngines() {
  const engines = [];
  if (findTool("espeak")) engines.push("espeak");
  if (process.platform === "darwin" && findTool("say")) engines.push("say");
  if (process.platform === "win32" && findTool("powershell")) engines.push("sapi");
  return engines;
}

const PS_SCRIPT = `param([string]$TextFile,[string]$OutFile,[int]$Rate,[string]$Voice)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { try { $s.SelectVoice($Voice) } catch {} }
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$s.Speak([System.IO.File]::ReadAllText($TextFile))
$s.Dispose()
`;

/** Text to a WAV buffer using a local engine. Throws ENGINE_UNAVAILABLE when none exists. */
export async function synthesizeSpeech(text, { voice, rate = 0, tempDir } = {}) {
  const clean = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  if (!clean) throw invalid("There is no text to speak.");
  if (clean.length > 20_000) throw invalid("Speech text is limited to 20,000 characters.");
  const engines = ttsEngines();
  if (!engines.length) throw unavailable("No local text-to-speech engine was found. Install espeak-ng (Linux/Windows) or use macOS say / Windows SAPI.");
  const r = Math.round(num(rate, -10, 10, "rate"));
  const safeVoice = voice && /^[A-Za-z0-9 ._+-]{1,60}$/.test(String(voice)) ? String(voice) : "";
  return withFiles(tempDir, { "speech.txt": Buffer.from(clean, "utf8") }, async ({ file, paths }) => {
    const out = file("speech.wav");
    const engine = engines[0];
    let run;
    if (engine === "espeak") {
      const args = ["-s", String(175 + r * 12), "-w", out, ...(safeVoice ? ["-v", safeVoice] : []), "-f", paths["speech.txt"]];
      run = await runTool(findTool("espeak"), args, { timeoutMs: 120_000 });
    } else if (engine === "say") {
      const aiff = file("speech.aiff");
      run = await runTool(findTool("say"), [...(safeVoice ? ["-v", safeVoice] : []), "-r", String(175 + r * 12), "-o", aiff, "-f", paths["speech.txt"]], { timeoutMs: 120_000 });
      if (run.code === 0) await ffmpeg(["-i", aiff, "-ar", "22050", "-ac", "1", out]);
    } else {
      const script = file("speak.ps1");
      await fsp.writeFile(script, PS_SCRIPT, "utf8");
      run = await runTool(findTool("powershell"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-TextFile", paths["speech.txt"], "-OutFile", out, "-Rate", String(r), "-Voice", safeVoice], { timeoutMs: 120_000 });
    }
    if (run.code !== 0) throw generationFailed(`The speech engine failed: ${run.stderr.trim().slice(0, 200) || `exit ${run.code}`}`);
    let wav;
    try { wav = await fsp.readFile(out); } catch { throw generationFailed("The speech engine produced no audio."); }
    if (wav.length < 100) throw generationFailed("The speech engine produced an empty file.");
    return { buffer: wav, engine };
  });
}

// ---------------------------------------------------------- speech: transcribe

export function transcriptionAvailable() {
  return !!findTool("whisper") && !!process.env.EXILE_WHISPER_MODEL;
}

/** Transcribe audio with a locally installed whisper.cpp build and model. */
export async function transcribeAudio(buffer, ext, { tempDir } = {}) {
  const bin = findTool("whisper");
  const model = process.env.EXILE_WHISPER_MODEL;
  if (!bin || !model) throw unavailable("Speech transcription needs a local whisper.cpp build: set EXILE_WHISPER_CLI and EXILE_WHISPER_MODEL. No cloud transcription is used.");
  if (!ffmpegAvailable()) throw unavailable("Transcription needs FFmpeg to prepare audio.");
  return withFiles(tempDir, { [`in.${ext}`]: buffer }, async ({ file, paths }) => {
    const wav = file("in16k.wav");
    await ffmpeg(["-i", paths[`in.${ext}`], "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const run = await runTool(bin, ["-m", model, "-f", wav, "-otxt", "-of", file("out"), "-nt"], { timeoutMs: 600_000 });
    if (run.code !== 0) throw generationFailed(`Transcription failed: ${run.stderr.trim().slice(0, 200)}`);
    let text;
    try { text = (await fsp.readFile(file("out.txt"), "utf8")).trim(); } catch { throw generationFailed("Transcription produced no output."); }
    return { text };
  });
}

// ------------------------------------------------------------------ encoding

const CODEC = {
  wav: ["-c:a", "pcm_s16le"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "128k"],
  ogg: ["-c:a", "libopus", "-b:a", "64k"],
  m4a: ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
};
const MUXER = { wav: "wav", mp3: "mp3", ogg: "ogg", m4a: "ipod" };

export function audioCodecArgs(format) {
  if (!CODEC[format]) throw invalid(`Unsupported audio format "${format}".`);
  return { codec: CODEC[format], muxer: MUXER[format] };
}

/** Convert any decodable audio buffer to the target format. */
export async function convertAudio(buffer, inExt, format, { tempDir, extraArgs = [], filter } = {}) {
  requireTools();
  const { codec, muxer } = audioCodecArgs(format);
  return withFiles(tempDir, { [`in.${inExt}`]: buffer }, async ({ file, paths }) => {
    const out = file(`out.${format}`);
    await ffmpeg(["-i", paths[`in.${inExt}`], "-vn", ...(filter ? ["-af", filter] : []), ...extraArgs, ...codec, "-f", muxer, out]);
    return fsp.readFile(out);
  });
}

function requireTools() {
  if (!ffmpegAvailable()) throw unavailable("FFmpeg is not installed, so audio conversion and processing are unavailable.");
}

/**
 * Edit operations: trim {startSec,endSec}, volume {factor}|{db}, fade {inSec,outSec},
 * normalize, speed {factor}. Applied as one filter chain so the audio is re-encoded once.
 */
export async function processAudio(buffer, inExt, ops, format, { tempDir } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw invalid("`operations` must be a non-empty array.");
  if (ops.length > 12) throw invalid("At most 12 audio operations are supported per edit.");
  requireTools();
  const filters = [];
  const trimArgs = [];
  for (const op of ops) {
    if (op.op === "trim") {
      const start = op.startSec === undefined ? 0 : num(op.startSec, 0, MEDIA_LIMITS.maxAudioSeconds, "startSec");
      if (op.endSec !== undefined) {
        const end = num(op.endSec, 0, MEDIA_LIMITS.maxAudioSeconds, "endSec");
        if (end <= start) throw invalid("endSec must be greater than startSec.");
        filters.push(`atrim=start=${fmtSec(start)}:end=${fmtSec(end)}`, "asetpts=PTS-STARTPTS");
      } else filters.push(`atrim=start=${fmtSec(start)}`, "asetpts=PTS-STARTPTS");
    } else if (op.op === "volume") {
      if (op.db !== undefined) filters.push(`volume=${fmtSec(num(op.db, -60, 40, "db"))}dB`);
      else filters.push(`volume=${fmtSec(num(op.factor, 0, 10, "factor"))}`);
    } else if (op.op === "fade") {
      const inSec = num(op.inSec ?? 0, 0, 60, "inSec");
      if (inSec > 0) filters.push(`afade=t=in:st=0:d=${fmtSec(inSec)}`);
      if (op.outSec) {
        const outSec = num(op.outSec, 0, 60, "outSec");
        const info = await durationOf(buffer, inExt, tempDir);
        const total = filtersDuration(info, ops);
        filters.push(`afade=t=out:st=${fmtSec(Math.max(0, total - outSec))}:d=${fmtSec(outSec)}`);
      }
    } else if (op.op === "normalize") filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    else if (op.op === "speed") {
      const f = num(op.factor, 0.5, 2, "factor");
      filters.push(`atempo=${fmtSec(f)}`);
    } else throw invalid(`Unknown audio operation "${String(op.op).slice(0, 30)}".`);
  }
  return convertAudio(buffer, inExt, format, { tempDir, filter: filters.join(","), extraArgs: trimArgs });
}

async function durationOf(buffer, ext, tempDir) {
  return withFiles(tempDir, { [`d.${ext}`]: buffer }, async ({ paths }) => (await probe(paths[`d.${ext}`])).duration);
}

/** Duration after the trim/speed operations that precede a fade. */
function filtersDuration(original, ops) {
  let d = original;
  for (const op of ops) {
    if (op.op === "trim") d = (op.endSec !== undefined ? Math.min(op.endSec, d) : d) - (op.startSec || 0);
    else if (op.op === "speed") d = d / Number(op.factor || 1);
  }
  return Math.max(0, d);
}

/** Join several audio buffers end to end. */
export async function concatAudio(parts, format, { tempDir } = {}) {
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > 40) throw invalid("Provide between 2 and 40 audio parts to join.");
  requireTools();
  const files = {};
  parts.forEach((p, i) => { files[`p${i}.${p.ext}`] = p.buffer; });
  return withFiles(tempDir, files, async ({ file, paths }) => {
    const inputs = parts.flatMap((p, i) => ["-i", paths[`p${i}.${p.ext}`]]);
    const graph = `${parts.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`).join(";")};${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
    const { codec, muxer } = audioCodecArgs(format);
    const out = file(`out.${format}`);
    await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", ...codec, "-f", muxer, out]);
    return fsp.readFile(out);
  });
}

/** Mix tracks (optionally with per-track volume) into one. */
export async function mixAudio(tracks, format, { tempDir } = {}) {
  if (!Array.isArray(tracks) || tracks.length < 2 || tracks.length > 12) throw invalid("Provide between 2 and 12 tracks to mix.");
  requireTools();
  const files = {};
  tracks.forEach((t, i) => { files[`t${i}.${t.ext}`] = t.buffer; });
  return withFiles(tempDir, files, async ({ file, paths }) => {
    const inputs = tracks.flatMap((t, i) => ["-i", paths[`t${i}.${t.ext}`]]);
    const vols = tracks.map((t, i) => `[${i}:a]aresample=44100,volume=${fmtSec(num(t.volume ?? 1, 0, 10, "volume"))}[m${i}]`);
    const graph = `${vols.join(";")};${tracks.map((_, i) => `[m${i}]`).join("")}amix=inputs=${tracks.length}:duration=longest:normalize=0[out]`;
    const { codec, muxer } = audioCodecArgs(format);
    const out = file(`out.${format}`);
    await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", ...codec, "-f", muxer, out]);
    return fsp.readFile(out);
  });
}

/** Pull the audio track out of a video. */
export async function extractAudio(videoBuffer, inExt, format, { tempDir } = {}) {
  requireTools();
  return withFiles(tempDir, { [`v.${inExt}`]: videoBuffer }, async ({ file, paths }) => {
    const info = await probe(paths[`v.${inExt}`]);
    if (!info.streams.some((s) => s.type === "audio")) throw invalid("The video has no audio track to extract.");
    return convertAudio(videoBuffer, inExt, format, { tempDir });
  });
}

// ---------------------------------------------------------------- validation

const AUDIO_EXPECT = {
  wav: { codecs: ["pcm_s16le"], formats: ["wav"] },
  mp3: { codecs: ["mp3"], formats: ["mp3"] },
  ogg: { codecs: ["opus", "vorbis"], formats: ["ogg"] },
  m4a: { codecs: ["aac"], formats: ["mov", "mp4", "m4a"] },
};

export async function validateAudio(buffer, format, spec, ctx) {
  const checks = [];
  const failures = [];
  const skipped = [];
  if (!ffmpegAvailable()) {
    // Without FFprobe we can still verify WAV structure ourselves; other formats cannot be verified.
    if (format === "wav" && buffer.length > 44 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE") {
      const rate = buffer.readUInt32LE(24);
      const bytes = buffer.readUInt32LE(40);
      const seconds = bytes / (rate * 2 * buffer.readUInt16LE(22));
      checks.push("WAV header is valid");
      if (seconds > 0) checks.push(`Duration ${seconds.toFixed(2)}s`); else failures.push("WAV has no audio data.");
      skipped.push("full decode (FFprobe unavailable)");
      return { checks, failures, skipped };
    }
    return { checks, failures: ["FFprobe is not installed, so this audio file cannot be verified."], skipped };
  }
  return withFiles(ctx.tempDir, { [`a.${format}`]: buffer }, async ({ paths }) => {
    const file = paths[`a.${format}`];
    let info;
    try { info = await probe(file); } catch (error) { return { checks, failures: [error.message], skipped }; }
    const audio = info.streams.find((s) => s.type === "audio");
    if (!audio) return { checks, failures: ["File has no audio stream."], skipped };
    const exp = AUDIO_EXPECT[format];
    if (exp && !exp.codecs.includes(audio.codec)) failures.push(`Audio codec is ${audio.codec}, expected ${exp.codecs.join("/")}.`);
    else checks.push(`Codec ${audio.codec}`);
    if (exp && !exp.formats.some((f) => info.format.split(",").includes(f))) failures.push(`Container is ${info.format}, expected ${exp.formats.join("/")}.`);
    else checks.push(`Container ${info.format.split(",")[0]}`);
    if (!(info.duration > 0)) failures.push("Audio has zero duration."); else checks.push(`Duration ${info.duration.toFixed(2)}s`);
    if (spec?.durationMs && Math.abs(info.duration * 1000 - spec.durationMs) > Math.max(150, spec.durationMs * 0.1) && spec.expectDuration !== false) failures.push("Duration does not match the request.");
    const errors = await fullDecodeErrors(file);
    if (errors.length) failures.push(`Decoder reported errors: ${errors[0]}`); else checks.push("Full decode completed without errors");
    if (!failures.length && spec?.allowSilence !== true) {
      const vol = await meanVolumeDb(file);
      if (vol === -Infinity || (vol !== null && vol < -70)) failures.push("Audio is silent.");
      else if (vol !== null) checks.push(`Audible (mean ${vol.toFixed(1)} dB)`);
    }
    return { checks, failures, skipped, info };
  });
}

function generator(format) {
  return {
    async generate(spec, ctx) {
      if (spec.text !== undefined) {
        // Speech: local engine only.
        const speech = await synthesizeSpeech(spec.text, { voice: spec.voice, rate: spec.rate, tempDir: ctx.tempDir });
        const buffer = format === "wav" ? speech.buffer : await convertAudio(speech.buffer, "wav", format, { tempDir: ctx.tempDir });
        return { buffer, metadata: { source: "tts", engine: speech.engine, characters: String(spec.text).length }, validationSpec: { ...spec, expectDuration: false } };
      }
      const wav = synthWav(spec);
      const buffer = format === "wav" ? wav.buffer : await convertAudio(wav.buffer, "wav", format, { tempDir: ctx.tempDir });
      return { buffer, metadata: { source: "synth", durationMs: wav.durationMs }, validationSpec: { durationMs: wav.durationMs, allowSilence: spec.tones?.every((t) => !t.freq) } };
    },
    validate: (buffer, spec, ctx) => validateAudio(buffer, format, spec, ctx),
  };
}

export const audioGenerators = { wav: generator("wav"), mp3: generator("mp3"), ogg: generator("ogg"), m4a: generator("m4a") };

export function audioCapabilities() {
  return {
    synthesis: { available: true, engine: "built-in" },
    textToSpeech: { available: ttsEngines().length > 0, engines: ttsEngines() },
    transcription: { available: transcriptionAvailable(), engine: transcriptionAvailable() ? "whisper.cpp" : null },
    processing: { available: ffmpegAvailable(), engine: ffmpegAvailable() ? "ffmpeg" : null },
  };
}
