/**
 * Video pipeline (FFmpeg). Kept separate from text-generation providers.
 *
 * Local capabilities: storyboard planning, scene rendering (procedural/SVG/supplied images,
 * captions burned into frames), assembly with transitions, narration + audio tracks,
 * trim, join, resize/convert, frame extraction, thumbnails, soft subtitles.
 * Text-to-video / image-to-video AI generation is NOT built in: see videoCapabilities().
 */
import fsp from "node:fs/promises";
import sharp from "sharp";
import { invalid, unavailable, generationFailed } from "./errors.mjs";
import { ffmpeg, probe, fullDecodeErrors, withFiles, MEDIA_LIMITS, num, fmtSec, ffmpegAvailable } from "./ffmpeg.mjs";
import { svgForSpec, proceduralSvg, sanitizeSvg } from "./images.mjs";
import { synthesizeSpeech, ttsEngines, convertAudio } from "./audio.mjs";
import { findTool } from "./tools.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TRANSITIONS = { none: null, fade: "fade", dissolve: "dissolve", wipeleft: "wipeleft", slideleft: "slideleft", circleopen: "circleopen" };

// ----------------------------------------------------------------- storyboard

/**
 * Deterministic storyboard from text: one scene per paragraph / bullet (max N).
 * An LLM can produce better scene text, but the storyboard itself is plain data and is
 * validated the same way whoever wrote it.
 */
export function planStoryboard({ text, scenes, title, secondsPerScene = 4, maxScenes = 12 }) {
  let list;
  if (Array.isArray(scenes)) list = scenes.map((s) => (typeof s === "string" ? { narration: s } : s));
  else {
    const raw = String(text ?? "").replace(/\r/g, "").split(/\n{2,}|\n(?=\s*(?:[-*]|\d+[.)])\s)/).map((p) => p.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").trim()).filter(Boolean);
    list = raw.map((p) => ({ narration: p }));
  }
  if (!list.length) throw invalid("There is nothing to plan: provide `text` or `scenes`.");
  const cap = Math.min(MEDIA_LIMITS.maxScenes, Math.max(1, Math.round(Number(maxScenes) || 12)));
  list = list.slice(0, cap);
  return {
    title: String(title || "").slice(0, 120),
    scenes: list.map((s, i) => {
      const narration = String(s.narration || s.caption || "").slice(0, 600);
      const words = narration.split(/\s+/).filter(Boolean).length;
      const durationSec = s.durationSec !== undefined ? num(s.durationSec, 1, 30, "durationSec") : Math.max(Number(secondsPerScene) || 4, Math.min(12, words / 2.6 + 1));
      return {
        index: i + 1,
        heading: String(s.heading || s.title || (i === 0 && title ? title : `Scene ${i + 1}`)).slice(0, 100),
        narration,
        caption: s.caption !== undefined ? String(s.caption).slice(0, 200) : narration.slice(0, 200),
        durationSec: Math.round(durationSec * 10) / 10,
        visual: s.visual || null,
      };
    }),
  };
}

// ----------------------------------------------------------------- frames

function dimsOf(spec) {
  const width = Math.round(num(spec.width ?? 1280, 64, MEDIA_LIMITS.maxWidth, "width"));
  const height = Math.round(num(spec.height ?? 720, 64, MEDIA_LIMITS.maxHeight, "height"));
  if (width % 2 || height % 2) throw invalid("Video width and height must be even numbers.");
  return { width, height };
}

const PALETTE = [["#0F2A52", "#0B4FB3"], ["#2B1B4E", "#7A3FB3"], ["#0E3B2E", "#1F9D6B"], ["#4A1F1F", "#D1593B"], ["#103B4A", "#2B9DB3"], ["#3B2A0E", "#C8892B"]];

function captionSvg(width, height, caption) {
  const size = Math.max(18, Math.round(height / 22));
  const maxChars = Math.max(12, Math.floor((width * 0.86) / (size * 0.52)));
  const lines = [];
  let line = "";
  for (const w of String(caption).split(/\s+/).filter(Boolean)) {
    if ((line + " " + w).trim().length > maxChars && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  if (!shown.length) return null;
  const boxH = shown.length * size * 1.3 + size;
  const y0 = height - boxH - Math.round(height * 0.05);
  const text = shown.map((l, i) => `<text x="${width / 2}" y="${(y0 + size * 1.25 + i * size * 1.3).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc(l)}</text>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${width * 0.04}" y="${y0}" width="${width * 0.92}" height="${boxH}" rx="12" fill="#000000" fill-opacity="0.62"/>${text}</svg>`);
}

/** One PNG frame image for a scene, with its caption burned in. */
export async function renderSceneFrame(scene, { width, height, index }) {
  let base;
  const v = scene.visual;
  if (v?.imageBase64) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.imageBase64)) throw invalid(`Scene ${index + 1} has invalid image data.`);
    base = await sharp(Buffer.from(v.imageBase64, "base64"), { limitInputPixels: 40_000_000, failOn: "error" }).resize(width, height, { fit: "contain", background: "#000000" }).png().toBuffer();
  } else {
    const svg = v?.svg
      ? sanitizeSvg(v.svg)
      : proceduralSvg({
        type: "card", width, height, title: scene.heading, subtitle: v?.subtitle || "",
        color1: PALETTE[index % PALETTE.length][0], color2: PALETTE[index % PALETTE.length][1], ...(v?.procedural || {}),
      });
    base = await sharp(Buffer.from(svg), { density: 72, limitInputPixels: 40_000_000 }).resize(width, height, { fit: "fill" }).png().toBuffer();
  }
  const cap = scene.showCaption === false ? null : captionSvg(width, height, scene.caption);
  return cap ? sharp(base).composite([{ input: cap, top: 0, left: 0 }]).png().toBuffer() : base;
}

// --------------------------------------------------------------- assembling

function videoCodecArgs(format, fps) {
  if (format === "mp4") return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart"];
  if (format === "webm") return ["-c:v", "libvpx", "-b:v", "1M", "-crf", "10", "-pix_fmt", "yuv420p", "-deadline", "realtime", "-cpu-used", "8", "-r", String(fps)];
  throw invalid(`Unsupported video format "${format}".`);
}
const audioArgsFor = (format) => (format === "webm" ? ["-c:a", "libopus", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "128k"]);

/**
 * Render scenes into a video.
 * spec: { storyboard | scenes | text, width, height, fps, transition, transitionSec,
 *         narrate, audioBase64 (+ audioExt), captions (default true) }
 */
export async function assembleVideo(spec, format, { tempDir }) {
  if (!ffmpegAvailable()) throw unavailable("FFmpeg is not installed, so video cannot be assembled. Storyboards can still be planned.");
  const { width, height } = dimsOf(spec);
  const fps = Math.round(num(spec.fps ?? 24, 1, MEDIA_LIMITS.maxFps, "fps"));
  const board = spec.storyboard?.scenes ? spec.storyboard : planStoryboard({ text: spec.text, scenes: spec.scenes, title: spec.title, secondsPerScene: spec.secondsPerScene });
  const transition = spec.transition || "none";
  if (!Object.hasOwn(TRANSITIONS, transition)) throw invalid(`Unknown transition. Use ${Object.keys(TRANSITIONS).join(", ")}.`);
  const tSec = transition === "none" ? 0 : num(spec.transitionSec ?? 0.5, 0.1, 2, "transitionSec");

  const scenes = board.scenes.map((s) => ({ ...s, showCaption: spec.captions !== false }));
  const narrations = [];
  if (spec.narrate) {
    if (!ttsEngines().length) throw unavailable("Narration was requested but no local text-to-speech engine is installed (espeak-ng, macOS say or Windows SAPI).");
    for (const s of scenes) {
      if (!s.narration) { narrations.push(null); continue; }
      const sp = await synthesizeSpeech(s.narration, { voice: spec.voice, rate: spec.rate, tempDir });
      narrations.push(sp.buffer);
    }
  }

  // Scene length: at least the planned duration, extended to fit its narration.
  const durations = [];
  for (let i = 0; i < scenes.length; i++) {
    let d = scenes[i].durationSec;
    if (narrations[i]) {
      const narrDur = await withFiles(tempDir, { "n.wav": narrations[i] }, async ({ paths }) => (await probe(paths["n.wav"])).duration);
      d = Math.max(d, narrDur + 0.4);
    }
    durations.push(d + tSec); // each clip carries its own overlap
  }
  // Each clip is its scene length plus one transition overlap; the chain removes one overlap per join.
  const planned = durations.reduce((a, b) => a + b, 0) - tSec * Math.max(0, scenes.length - 1);
  if (planned > MEDIA_LIMITS.maxVideoSeconds) throw invalid(`The video would be ${Math.round(planned)}s; the limit is ${MEDIA_LIMITS.maxVideoSeconds}s.`);

  const files = {};
  for (let i = 0; i < scenes.length; i++) files[`s${i}.png`] = await renderSceneFrame(scenes[i], { width, height, index: i });
  let audioExt = null;
  if (spec.audioBase64) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spec.audioBase64)) throw invalid("`audioBase64` is not valid base64.");
    audioExt = ["wav", "mp3", "ogg", "m4a"].includes(spec.audioExt) ? spec.audioExt : "wav";
    files[`track.${audioExt}`] = Buffer.from(spec.audioBase64, "base64");
  }

  return withFiles(tempDir, files, async ({ file, paths }) => {
    // 1. One silent clip per scene.
    const clipNames = [];
    for (let i = 0; i < scenes.length; i++) {
      const out = file(`c${i}.mp4`);
      await ffmpeg(["-loop", "1", "-framerate", String(fps), "-i", paths[`s${i}.png`], "-t", fmtSec(durations[i]), "-vf", `scale=${width}:${height},format=yuv420p,setsar=1`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(fps), out]);
      clipNames.push(out);
    }
    // 2. Join with transitions (xfade) or plain concat.
    const joined = file("joined.mp4");
    if (clipNames.length === 1) await fsp.copyFile(clipNames[0], joined);
    else if (tSec === 0) {
      const inputs = clipNames.flatMap((c) => ["-i", c]);
      await ffmpeg([...inputs, "-filter_complex", `${clipNames.map((_, i) => `[${i}:v]`).join("")}concat=n=${clipNames.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", joined]);
    } else {
      const inputs = clipNames.flatMap((c) => ["-i", c]);
      const xf = TRANSITIONS[transition];
      let chain = "";
      let last = "[0:v]";
      let acc = durations[0];
      for (let i = 1; i < clipNames.length; i++) {
        const offset = acc - tSec;
        const label = i === clipNames.length - 1 ? "[v]" : `[x${i}]`;
        chain += `${last}[${i}:v]xfade=transition=${xf}:duration=${fmtSec(tSec)}:offset=${fmtSec(offset)}${label};`;
        last = label;
        acc = acc + durations[i] - tSec;
      }
      await ffmpeg([...inputs, "-filter_complex", chain.replace(/;$/, ""), "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", joined]);
    }
    const videoInfo = await probe(joined);

    // 3. Audio: narration placed at each scene start, plus an optional music/voice track.
    let audioInput = null;
    if (narrations.some(Boolean) || audioExt) {
      const parts = [];
      const args = [];
      let n = 0;
      const starts = [];
      let at = 0;
      durations.forEach((d) => { starts.push(at); at += d - tSec; });
      for (let i = 0; i < narrations.length; i++) {
        if (!narrations[i]) continue;
        const nf = file(`n${i}.wav`);
        await fsp.writeFile(nf, narrations[i]);
        args.push("-i", nf);
        parts.push(`[${n}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(starts[i] * 1000)}:all=1[n${n}]`);
        n++;
      }
      if (audioExt) {
        args.push("-i", paths[`track.${audioExt}`]);
        parts.push(`[${n}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${fmtSec(num(spec.trackVolume ?? (narrations.some(Boolean) ? 0.25 : 1), 0, 4, "trackVolume"))}[n${n}]`);
        n++;
      }
      const mixed = file("audio.wav");
      await ffmpeg([...args, "-filter_complex", `${parts.join(";")};${Array.from({ length: n }, (_, i) => `[n${i}]`).join("")}amix=inputs=${n}:duration=longest:normalize=0,apad[a]`, "-map", "[a]", "-t", fmtSec(videoInfo.duration), "-c:a", "pcm_s16le", mixed]);
      audioInput = mixed;
    }

    // 4. Final encode.
    const out = file(`final.${format}`);
    await ffmpeg([
      "-i", joined, ...(audioInput ? ["-i", audioInput] : []),
      ...videoCodecArgs(format, fps), ...(audioInput ? [...audioArgsFor(format), "-shortest"] : ["-an"]),
      out,
    ]);
    const buffer = await fsp.readFile(out);
    return {
      buffer,
      metadata: { width, height, fps, scenes: scenes.length, transition, narrated: narrations.some(Boolean), hasAudio: !!audioInput, expectedSeconds: Math.round(videoInfo.duration * 100) / 100, storyboard: board },
      validationSpec: { width, height, expectedSeconds: videoInfo.duration, expectAudio: !!audioInput },
    };
  });
}

// ---------------------------------------------------------- edit operations

function requireFf() {
  if (!ffmpegAvailable()) throw unavailable("FFmpeg is not installed, so video processing is unavailable.");
}

export async function trimVideo(buffer, inExt, format, { startSec = 0, endSec }, { tempDir }) {
  requireFf();
  const start = num(startSec, 0, 36000, "startSec");
  const end = num(endSec, 0.1, 36000, "endSec");
  if (end <= start) throw invalid("endSec must be greater than startSec.");
  return withFiles(tempDir, { [`v.${inExt}`]: buffer }, async ({ file, paths }) => {
    const info = await probe(paths[`v.${inExt}`]);
    if (start >= info.duration) throw invalid("startSec is beyond the end of the video.");
    const out = file(`o.${format}`);
    const hasAudio = info.streams.some((s) => s.type === "audio");
    // Re-encode so the cut is frame-accurate and the output always starts on a keyframe.
    await ffmpeg(["-ss", fmtSec(start), "-i", paths[`v.${inExt}`], "-t", fmtSec(end - start), ...videoCodecArgs(format, Math.round(info.streams.find((s) => s.type === "video")?.fps || 24)), ...(hasAudio ? audioArgsFor(format) : ["-an"]), out]);
    return fsp.readFile(out);
  });
}

export async function joinVideos(parts, format, { width, height, fps = 24, tempDir }) {
  requireFf();
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > 20) throw invalid("Provide between 2 and 20 clips to join.");
  const w = Math.round(num(width ?? 1280, 64, MEDIA_LIMITS.maxWidth, "width"));
  const h = Math.round(num(height ?? 720, 64, MEDIA_LIMITS.maxHeight, "height"));
  const files = {};
  parts.forEach((p, i) => { files[`p${i}.${p.ext}`] = p.buffer; });
  return withFiles(tempDir, files, async ({ file, paths }) => {
    const infos = await Promise.all(parts.map((p, i) => probe(paths[`p${i}.${p.ext}`])));
    const total = infos.reduce((a, i) => a + i.duration, 0);
    if (total > MEDIA_LIMITS.maxVideoSeconds) throw invalid(`The joined video would be ${Math.round(total)}s; the limit is ${MEDIA_LIMITS.maxVideoSeconds}s.`);
    const inputs = parts.flatMap((p, i) => ["-i", paths[`p${i}.${p.ext}`]]);
    // Every clip is normalised to the same size/fps and always carries an audio stream (silence if absent).
    const norm = infos.map((info, i) => {
      const hasA = info.streams.some((s) => s.type === "audio");
      const v = `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
      const a = hasA ? `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]` : `anullsrc=r=44100:cl=stereo,atrim=duration=${fmtSec(info.duration)}[a${i}]`;
      return `${v};${a}`;
    });
    const graph = `${norm.join(";")};${parts.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${parts.length}:v=1:a=1[v][a]`;
    const out = file(`o.${format}`);
    await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...videoCodecArgs(format, fps), ...audioArgsFor(format), out]);
    return fsp.readFile(out);
  });
}

export async function convertVideo(buffer, inExt, format, { width, height, fps } = {}, { tempDir }) {
  requireFf();
  return withFiles(tempDir, { [`v.${inExt}`]: buffer }, async ({ file, paths }) => {
    const info = await probe(paths[`v.${inExt}`]);
    const v = info.streams.find((s) => s.type === "video");
    if (!v) throw invalid("The file has no video stream.");
    if (info.duration > MEDIA_LIMITS.maxVideoSeconds) throw invalid(`Videos longer than ${MEDIA_LIMITS.maxVideoSeconds}s are not processed.`);
    const w = width ? Math.round(num(width, 64, MEDIA_LIMITS.maxWidth, "width")) : null;
    const h = height ? Math.round(num(height, 64, MEDIA_LIMITS.maxHeight, "height")) : null;
    const vf = w || h ? ["-vf", `scale=${w ?? -2}:${h ?? -2}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`] : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
    const hasAudio = info.streams.some((s) => s.type === "audio");
    const out = file(`o.${format}`);
    await ffmpeg(["-i", paths[`v.${inExt}`], ...vf, ...videoCodecArgs(format, Math.round(num(fps ?? (v.fps || 24), 1, MEDIA_LIMITS.maxFps, "fps"))), ...(hasAudio ? audioArgsFor(format) : ["-an"]), out]);
    return fsp.readFile(out);
  });
}

/** One frame as a PNG. `atSec` defaults to the middle of the video. */
export async function extractFrame(buffer, inExt, { atSec } = {}, { tempDir }) {
  requireFf();
  return withFiles(tempDir, { [`v.${inExt}`]: buffer }, async ({ file, paths }) => {
    const info = await probe(paths[`v.${inExt}`]);
    if (!info.streams.some((s) => s.type === "video")) throw invalid("The file has no video stream.");
    const t = atSec === undefined ? info.duration / 2 : num(atSec, 0, info.duration, "atSec");
    const out = file("f.png");
    await ffmpeg(["-ss", fmtSec(Math.min(t, Math.max(0, info.duration - 0.05))), "-i", paths[`v.${inExt}`], "-frames:v", "1", out]);
    return fsp.readFile(out);
  });
}

export const thumbnail = (buffer, inExt, opts, ctx) => extractFrame(buffer, inExt, opts, ctx);

/** Replace or add an audio track (no re-encode of video where the container allows it). */
export async function addAudioToVideo(videoBuffer, videoExt, audioBuffer, audioExt, format, { volume = 1, tempDir }) {
  requireFf();
  return withFiles(tempDir, { [`v.${videoExt}`]: videoBuffer, [`a.${audioExt}`]: audioBuffer }, async ({ file, paths }) => {
    const info = await probe(paths[`v.${videoExt}`]);
    const out = file(`o.${format}`);
    await ffmpeg(["-i", paths[`v.${videoExt}`], "-i", paths[`a.${audioExt}`], "-map", "0:v:0", "-map", "1:a:0", "-af", `volume=${fmtSec(num(volume, 0, 4, "volume"))}`, "-t", fmtSec(info.duration), ...videoCodecArgs(format, Math.round(info.streams.find((s) => s.type === "video")?.fps || 24)), ...audioArgsFor(format), "-shortest", out]);
    return fsp.readFile(out);
  });
}

/** SRT text for a storyboard (also usable as a sidecar subtitle file). */
export function storyboardToSrt(board) {
  const ts = (sec) => {
    const ms = Math.round(sec * 1000);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  let at = 0;
  return board.scenes.map((s, i) => {
    const block = `${i + 1}\n${ts(at)} --> ${ts(at + s.durationSec)}\n${s.caption || s.narration}\n`;
    at += s.durationSec;
    return block;
  }).join("\n");
}

// --------------------------------------------------------------- validation

const VIDEO_EXPECT = { mp4: { codec: "h264", formats: ["mov", "mp4"] }, webm: { codec: "vp8", formats: ["webm", "matroska"] } };

export async function validateVideo(buffer, format, spec, ctx) {
  const checks = [];
  const failures = [];
  const skipped = [];
  if (!ffmpegAvailable()) return { checks, failures: ["FFmpeg/FFprobe is not installed, so this video cannot be verified."], skipped };
  return withFiles(ctx.tempDir, { [`v.${format}`]: buffer }, async ({ paths, file }) => {
    const f = paths[`v.${format}`];
    let info;
    try { info = await probe(f); } catch (error) { return { checks, failures: [error.message], skipped }; }
    const video = info.streams.find((s) => s.type === "video");
    if (!video) return { checks, failures: ["File has no video stream."], skipped };
    const exp = VIDEO_EXPECT[format];
    if (exp.codec !== video.codec) failures.push(`Video codec is ${video.codec}, expected ${exp.codec}.`); else checks.push(`Video codec ${video.codec}`);
    if (!exp.formats.some((x) => info.format.split(",").includes(x))) failures.push(`Container is ${info.format}, expected ${exp.formats.join("/")}.`); else checks.push(`Container ${info.format.split(",")[0]}`);
    if (!(info.duration > 0)) failures.push("Video has zero duration."); else checks.push(`Duration ${info.duration.toFixed(2)}s`);
    if (spec?.width && (video.width !== spec.width || video.height !== spec.height)) failures.push(`Resolution is ${video.width}x${video.height}, expected ${spec.width}x${spec.height}.`);
    else if (spec?.width) checks.push(`Resolution ${video.width}x${video.height}`);
    if (spec?.expectedSeconds && Math.abs(info.duration - spec.expectedSeconds) > Math.max(0.3, spec.expectedSeconds * 0.05)) failures.push(`Duration ${info.duration.toFixed(2)}s differs from the expected ${spec.expectedSeconds.toFixed(2)}s.`);
    const hasAudio = info.streams.some((s) => s.type === "audio");
    if (spec?.expectAudio === true && !hasAudio) failures.push("Expected an audio stream but none was found.");
    else if (spec?.expectAudio === true) checks.push("Audio stream present");
    const errors = await fullDecodeErrors(f);
    if (errors.length) failures.push(`Decoder reported errors: ${errors[0]}`); else checks.push("Every frame decodes without errors");
    if (!failures.length) {
      try {
        const frame = await extractFrame(buffer, format, {}, ctx);
        const stats = await sharp(frame).stats();
        if (Math.max(...stats.channels.map((c) => c.stdev)) < 0.5) failures.push("The middle frame is a single flat colour (blank).");
        else checks.push("Middle frame has visible content");
      } catch (error) { failures.push(`Frame inspection failed: ${error.message}`); }
    }
    return { checks, failures, skipped };
  });
}

export const videoGenerators = {
  mp4: { generate: (spec, ctx) => assembleVideo(spec, "mp4", ctx), validate: (b, s, c) => validateVideo(b, "mp4", s, c) },
  webm: { generate: (spec, ctx) => assembleVideo(spec, "webm", ctx), validate: (b, s, c) => validateVideo(b, "webm", s, c) },
};

export function videoCapabilities() {
  const ff = ffmpegAvailable();
  return {
    storyboard: { available: true, engine: "built-in" },
    assembly: { available: ff, engine: ff ? "ffmpeg" : null },
    processing: { available: ff, engine: ff ? "ffmpeg" : null, operations: ["trim", "join", "convert", "resize", "frame", "thumbnail", "audio"] },
    narration: { available: ff && ttsEngines().length > 0, engines: ttsEngines() },
    aiVideoGeneration: { available: false, reason: "No text-to-video or image-to-video provider is connected. Storyboards are rendered locally from procedural frames or supplied images." },
  };
}

export { convertAudio, findTool };
