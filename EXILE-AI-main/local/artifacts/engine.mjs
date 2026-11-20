/**
 * The universal artifact engine.
 *
 * Every creation passes: understand -> (research) -> generate -> validate -> (repair) -> save.
 * Progress events are emitted only for work that actually happens. A file that fails validation
 * is never stored and never reported as a success.
 *
 * Generation is declarative: engines take structured specs (Markdown, rows, slides, SVG, scene
 * lists) and run vetted code. Model-written code is never executed, so there is no sandbox to
 * escape; everything that spawns a process (FFmpeg, LibreOffice, TTS) runs with an argument
 * array, a timeout, a minimal environment and a per-job temp directory.
 */
import fsp from "node:fs/promises";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { FORMATS, getFormat, requireFormat, INLINE_SAFE_MIMES, WHATSAPP_MAX_BYTES } from "./formats.mjs";
import { ArtifactError, invalid, unavailable, generationFailed, redact, toErrorCode } from "./errors.mjs";
import { ArtifactStore, newJobId, isArtifactId } from "./store.mjs";
import { documentGenerators } from "./documents.mjs";
import { dataGenerators, parseCsv, serializeCsv } from "./data.mjs";
import { presentationGenerators } from "./presentation.mjs";
import { archiveGenerators } from "./archive.mjs";
import { IMAGE_LIMITS, imageGenerators, processImage, variationSpecs } from "./images.mjs";
import { audioGenerators, processAudio, convertAudio, extractAudio, concatAudio, mixAudio, audioCapabilities } from "./audio.mjs";
import { videoGenerators, trimVideo, convertVideo, extractFrame, addAudioToVideo, joinVideos, videoCapabilities, planStoryboard } from "./video.mjs";
import { convertWithOffice, extractPdfText } from "./render.mjs";
import { readZipChecked, utf8, makeZip } from "./zip-utils.mjs";
import { ffmpegAvailable } from "./ffmpeg.mjs";
import { findTool } from "./tools.mjs";
import { generateWithLocalSd, sdAvailable } from "./sd-local.mjs";
import { detectArtifactRequest, contentPrompt, looksLikeRefusal, suggestName } from "./request.mjs";
import { cleanContent } from "./markdown.mjs";

const GENERATORS = {
  ...documentGenerators,
  ...dataGenerators,
  pptx: presentationGenerators.pptx,
  "pdf-slides": presentationGenerators["pdf-slides"],
  ...archiveGenerators,
  ...imageGenerators,
  ...audioGenerators,
  ...videoGenerators,
};

const STAGES = ["queued", "understanding", "researching", "generating", "processing", "validating", "repairing", "saving", "delivering", "completed", "failed"];
const MAX_JOBS = 100;
const MAX_STORED_SPEC_CHARS = 8000;

function pickGenerator(format, spec) {
  if (format === "pdf" && spec && (Array.isArray(spec.slides) || spec.asSlides === true)) return GENERATORS["pdf-slides"];
  return GENERATORS[format];
}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ArtifactError("TIMEOUT", `${label} exceeded the ${Math.round(ms / 1000)}s time limit.`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export class ArtifactEngine {
  /**
   * @param {object} o
   * @param {ArtifactStore} o.store
   * @param {{generateText:Function,status:Function}} [o.textRouter] capability router for text
   * @param {Record<string, Function>} [o.senders] delivery channels, e.g. { whatsapp({to,dataUrl,filename,caption}) }
   * @param {number} [o.maxConcurrent]
   * @param {number} [o.generationTimeoutMs]
   * @param {number} [o.maxRepairs]
   */
  constructor({ store, textRouter = null, imageRouter = null, senders = {}, maxConcurrent = 2, generationTimeoutMs = 240_000, maxRepairs = 2, now = () => Date.now() }) {
    if (!(store instanceof ArtifactStore)) throw new Error("ArtifactEngine needs an ArtifactStore.");
    this.store = store;
    this.textRouter = textRouter;
    this.imageRouter = imageRouter;
    this.senders = senders;
    this.sem = new Semaphore(Math.max(1, maxConcurrent));
    this.generationTimeoutMs = generationTimeoutMs;
    this.maxRepairs = maxRepairs;
    this.now = now;
    this.jobs = new Map();
  }

  // ------------------------------------------------------------- capabilities

  capabilities() {
    const ff = ffmpegAvailable();
    const office = !!findTool("soffice");
    const formats = Object.entries(FORMATS).map(([id, f]) => {
      let available = true;
      let engine = "built-in";
      let reason;
      if (["mp3", "ogg", "m4a"].includes(id)) { available = ff; engine = "ffmpeg"; if (!ff) reason = "FFmpeg is not installed"; }
      if (["mp4", "webm"].includes(id)) { available = ff; engine = "ffmpeg"; if (!ff) reason = "FFmpeg is not installed"; }
      if (id === "wav") engine = ff ? "built-in + ffmpeg validation" : "built-in (structure check only)";
      return { format: id, label: f.label, mime: f.mime, kind: f.kind, available, engine, ...(reason ? { reason } : {}), whatsapp: f.whatsapp !== null, preview: f.preview };
    });
    return {
      formats,
      validation: {
        officeRendering: office ? "LibreOffice available: DOCX/RTF/PPTX layout and XLSX formulas are rendered and checked" : "LibreOffice not installed: structure and content checks only",
        mediaDecoding: ff ? "FFprobe/FFmpeg available: media is fully decoded" : "FFmpeg not installed: media cannot be verified",
      },
      engines: {
        documents: { local: true },
        images: { local: true, procedural: true, svg: true, processing: "sharp", aiLocalStableDiffusion: sdAvailable() },
        audio: audioCapabilities(),
        video: videoCapabilities(),
        office: { libreOffice: office },
      },
      providers: this.textRouter ? this.textRouter.status() : { text: { providers: [], note: "No text router configured" } },
      limits: { whatsappAttachmentBytes: WHATSAPP_MAX_BYTES },
      conversions: CONVERSIONS_DESCRIPTION,
    };
  }

  // ------------------------------------------------------------------- jobs

  startJob(meta = {}) {
    const id = newJobId();
    const job = { id, state: "running", startedAt: this.now(), events: [], ...meta };
    this.jobs.set(id, job);
    if (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].filter((j) => j.state !== "running").sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.jobs.delete(oldest.id);
    }
    return job;
  }

  getJob(id) {
    const j = this.jobs.get(id);
    return j ? { id: j.id, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt, events: j.events.slice(), result: j.result } : null;
  }

  #emit(job, onEvent, stage, message, extra = {}) {
    const event = { t: this.now(), stage, message, ...extra };
    job.events.push(event);
    if (job.events.length > 200) job.events.shift();
    try { onEvent?.(event); } catch { /* a broken listener must not break the pipeline */ }
  }

  // ----------------------------------------------------------------- create

  /**
   * Create an artifact.
   * Provide either `spec` (declarative input for the format) or `prompt` (natural language; a
   * permitted text provider writes the content). `format` may be omitted with a prompt.
   */
  async create({ format, spec, prompt, name, onEvent, repair, jobId, research, provider } = {}) {
    const job = jobId && this.jobs.get(jobId) ? this.jobs.get(jobId) : this.startJob({ kind: "create" });
    const emit = (stage, message, extra) => this.#emit(job, onEvent, stage, message, extra);
    let tempDir;
    await this.sem.acquire();
    try {
      emit("understanding", "Understanding the request");
      let fmt;
      let currentSpec = spec;
      let source = { method: spec ? "spec" : "prompt" };
      if (prompt !== undefined && prompt !== null && !spec) {
        const request = String(prompt);
        if (!request.trim()) throw invalid("The request is empty.");
        const detected = format ? null : detectArtifactRequest(request);
        if (!format && detected?.unsupported) throw invalid(detected.message);
        fmt = requireFormat(format || detected?.format || (() => { throw invalid("I couldn't tell which file type you want. Say, for example, PDF, Word, Excel, PowerPoint, CSV, or an image."); })());
        if (!GENERATORS[fmt.id]) throw unavailable(`Generation for ${fmt.label} is not available.`);
        if (typeof research === "function") {
          emit("researching", "Researching");
          const notes = await research(request);
          source.research = Array.isArray(notes?.sources) ? notes.sources.slice(0, 20) : [];
        }
        if (!this.textRouter) throw new ArtifactError("PROVIDER_FAILURE", "No text provider is configured, so content cannot be written from a prompt. Provide a structured spec instead.");
        emit("generating", `Writing ${fmt.label} content`);
        const written = await this.#writeContent(fmt.id, request, undefined, provider);
        currentSpec = written.spec;
        source = { ...source, provider: written.provider, request: request.slice(0, 500) };
        name = name || suggestName(fmt.id, request);
        repair = repair || (async ({ failures, attempt }) => {
          emit("repairing", `Asking the provider to fix: ${failures[0] || "invalid output"}`, { attempt });
          const again = await this.#writeContent(fmt.id, request, failures, provider);
          return again.spec;
        });
      } else {
        fmt = requireFormat(format);
        if (!currentSpec || typeof currentSpec !== "object") throw invalid("A `spec` object (or a `prompt`) is required.");
        if (!GENERATORS[fmt.id]) throw unavailable(`Generation for ${fmt.label} is not available.`);
      }

      tempDir = await this.store.makeTempDir(job.id);
      const ctx = { tempDir };
      let attempt = 0;
      let built;
      let validation;
      for (;;) {
        emit("generating", `Generating ${fmt.label}`, { attempt });
        const generator = pickGenerator(fmt.id, currentSpec);
        const needsProcessing = ["audio", "video", "image"].includes(fmt.kind) || fmt.id === "pptx";
        if (needsProcessing) emit("processing", fmt.kind === "video" ? "Rendering frames and encoding video" : "Processing");
        try {
          built = await withTimeout(Promise.resolve(generator.generate(currentSpec, ctx)), this.generationTimeoutMs, "Generation");
        } catch (error) {
          const repairable = repair && attempt < this.maxRepairs && ["INVALID_INPUT", "GENERATION_FAILURE"].includes(toErrorCode(error));
          if (!repairable) throw error;
          attempt++;
          currentSpec = await repair({ spec: currentSpec, failures: [error.message], attempt });
          continue;
        }
        emit("validating", "Validating the file");
        const vspec = built.validationSpec ?? currentSpec;
        validation = await withTimeout(Promise.resolve(generator.validate(built.buffer, vspec, ctx)), this.generationTimeoutMs, "Validation");
        if (!validation.failures.length) break;
        if (repair && attempt < this.maxRepairs) {
          attempt++;
          currentSpec = await repair({ spec: currentSpec, failures: validation.failures, attempt });
          continue;
        }
        break;
      }

      const report = { passed: validation.failures.length === 0, checks: validation.checks, failures: validation.failures, skipped: validation.skipped || [] };
      if (!report.passed) {
        await this.store.audit("artifact.validation_failed", { format: fmt.id, failures: report.failures.slice(0, 3).join(" | ") });
        throw new ArtifactError("VALIDATION_FAILURE", `The ${fmt.label} failed validation and was not saved: ${report.failures[0]}`, { validation: report });
      }
      emit("saving", "Saving the artifact");
      const stored = await this.store.create({
        name: name || `exile-${fmt.id}`, format: fmt.id, buffer: built.buffer, validation: report,
        source: { ...source, ...storableSource(currentSpec, fmt) }, metadata: built.metadata,
      });
      const result = this.#result(stored, stored.versions[0], job.id);
      job.state = "succeeded"; job.finishedAt = this.now(); job.result = result;
      emit("completed", `${fmt.label} created and verified`, { artifactId: stored.id });
      return result;
    } catch (error) {
      return this.#fail(job, onEvent, error);
    } finally {
      this.sem.release();
      await this.store.cleanupTemp(tempDir);
    }
  }

  async #writeContent(formatId, request, failures, provider) {
    const p = contentPrompt(formatId, request);
    const fix = failures?.length ? `\n\nYour previous output was rejected: ${failures.slice(0, 3).join("; ")}. Return a corrected version.` : "";
    const out = await this.textRouter.generateText({ system: p.system, prompt: p.user + fix, provider });
    if (looksLikeRefusal(out.text)) throw new ArtifactError("PROVIDER_FAILURE", `The provider ${out.provider} refused instead of writing content.`);
    return { spec: specFromContent(formatId, out.text, request), provider: out.provider };
  }

  #fail(job, onEvent, error) {
    const code = toErrorCode(error);
    const message = redact(error.message);
    job.state = "failed"; job.finishedAt = this.now();
    const result = { success: false, error: message, code, jobId: job.id, ...(error.details?.validation ? { validation: error.details.validation } : {}) };
    job.result = result;
    this.#emit(job, onEvent, "failed", message, { code });
    this.store.audit("artifact.failed", { jobId: job.id, code, error: message }).catch(() => {});
    return result;
  }

  #result(meta, record, jobId) {
    return {
      success: true,
      artifactId: meta.id,
      name: meta.name,
      mimeType: meta.mime,
      extension: meta.ext,
      sizeBytes: record.sizeBytes,
      version: record.version,
      storageUri: `artifact://${meta.id}/v${record.version}`,
      previewUri: `/artifacts/${meta.id}/preview`,
      downloadUri: `/artifacts/${meta.id}/download`,
      state: "validated",
      validation: record.validation,
      metadata: record.metadata,
      ...(jobId ? { jobId } : {}),
    };
  }

  // ------------------------------------------------------------------- read

  async list(opts) {
    return (await this.store.list(opts)).map((m) => summary(m));
  }

  async describe(id) {
    const meta = await this.store.get(id);
    return {
      ...summary(meta),
      versionList: meta.versions.map((v) => ({ version: v.version, sizeBytes: v.sizeBytes, createdAt: v.createdAt, sha256: v.sha256, validation: v.validation, source: { method: v.source?.method, operation: v.source?.operation } })),
      deliveries: meta.deliveries,
      derivedFrom: meta.derivedFrom,
    };
  }

  async read(id, version) {
    const { meta, record, buffer } = await this.store.readVersion(id, version);
    return { meta, record, buffer, format: getFormat(meta.format) };
  }

  async delete(id, { confirm } = {}) {
    if (!isArtifactId(id)) throw invalid("Invalid artifact id.");
    if (confirm !== id) throw new ArtifactError("FORBIDDEN", "Deleting an artifact needs explicit confirmation: pass confirm equal to the artifact id.");
    await this.store.delete(id);
    return { deleted: true, artifactId: id };
  }

  // ------------------------------------------------------------------- edit

  /**
   * New version of an artifact. Either `spec` (regenerate from new declarative input) or
   * `operations` (image, audio and video edits applied to the current version).
   */
  async edit(id, { spec, operations, onEvent, quality } = {}) {
    const job = this.startJob({ kind: "edit", artifactId: id });
    const emit = (stage, message, extra) => this.#emit(job, onEvent, stage, message, extra);
    let tempDir;
    await this.sem.acquire();
    try {
      emit("understanding", "Understanding the edit");
      const current = await this.store.readVersion(id);
      const fmt = getFormat(current.meta.format);
      tempDir = await this.store.makeTempDir(job.id);
      const ctx = { tempDir };
      let buffer;
      let metadata = {};
      let source;
      let validationSpec;
      if (operations) {
        emit("processing", `Applying ${operations.length} operation${operations.length === 1 ? "" : "s"}`);
        source = { method: "edit", operation: "operations", ops: operations.map((o) => o.op).slice(0, 20) };
        if (fmt.kind === "image" && fmt.id !== "svg") buffer = (await processImage(current.buffer, await resolveOverlays(operations, this), fmt.id, { quality })).buffer;
        else if (fmt.kind === "audio") buffer = await processAudio(current.buffer, fmt.ext, operations, fmt.id, ctx);
        else if (fmt.kind === "video") buffer = await editVideo(current.buffer, fmt, operations, ctx, this);
        else throw invalid(`Operation-based edits are supported for images, audio and video. Provide a new \`spec\` to edit a ${fmt.label}.`);
      } else if (spec && typeof spec === "object") {
        emit("generating", `Regenerating ${fmt.label}`);
        const generator = pickGenerator(fmt.id, spec);
        const built = await withTimeout(Promise.resolve(generator.generate(spec, ctx)), this.generationTimeoutMs, "Generation");
        buffer = built.buffer; metadata = built.metadata || {}; validationSpec = built.validationSpec ?? spec;
        source = { method: "edit", operation: "spec", ...storableSource(spec, fmt) };
      } else throw invalid("Provide `operations` or a `spec`.");

      emit("validating", "Validating the new version");
      const generator = pickGenerator(fmt.id, spec);
      const v = await withTimeout(Promise.resolve(generator.validate(buffer, validationSpec, ctx)), this.generationTimeoutMs, "Validation");
      const report = { passed: v.failures.length === 0, checks: v.checks, failures: v.failures, skipped: v.skipped || [] };
      if (!report.passed) throw new ArtifactError("VALIDATION_FAILURE", `The edited ${fmt.label} failed validation and was not saved: ${report.failures[0]}`, { validation: report });
      emit("saving", "Saving the new version");
      const next = await this.store.addVersion(id, { buffer, validation: report, source, metadata });
      const result = this.#result(next, next.versions[next.versions.length - 1], job.id);
      job.state = "succeeded"; job.finishedAt = this.now(); job.result = result;
      emit("completed", "New version saved", { artifactId: id, version: result.version });
      return result;
    } catch (error) {
      return this.#fail(job, onEvent, error);
    } finally {
      this.sem.release();
      await this.store.cleanupTemp(tempDir);
    }
  }

  /** Procedural images only: new artifacts that vary the seed and palette of the original. */
  async variations(id, { count = 3, onEvent } = {}) {
    const current = await this.store.readVersion(id);
    const proc = current.record.source?.procedural;
    if (current.meta.kind !== "image" || !proc) {
      return [{ success: false, code: "INVALID_INPUT", error: "Variations are available for artifacts created from a procedural image spec." }];
    }
    const out = [];
    for (const p of variationSpecs(proc, count)) {
      out.push(await this.create({ format: current.meta.format, spec: { procedural: p }, name: current.meta.name.replace(/\.[^.]+$/, "") + "-variation", onEvent }));
    }
    return out;
  }

  // ---------------------------------------------------------------- convert

  async convert(id, targetFormat, options = {}) {
    const job = this.startJob({ kind: "convert", artifactId: id });
    const emit = (stage, message, extra) => this.#emit(job, options.onEvent, stage, message, extra);
    let tempDir;
    await this.sem.acquire();
    try {
      emit("understanding", "Understanding the conversion");
      const target = requireFormat(targetFormat);
      const current = await this.store.readVersion(id);
      const src = getFormat(current.meta.format);
      if (src.id === target.id) throw invalid(`The artifact is already a ${target.label}.`);
      tempDir = await this.store.makeTempDir(job.id);
      const ctx = { tempDir };
      emit("processing", `Converting ${src.label} to ${target.label}`);
      const built = await withTimeout(convertBuffer(current.buffer, src, target, options, ctx), this.generationTimeoutMs, "Conversion");
      emit("validating", "Validating the converted file");
      const generator = pickGenerator(target.id, built.spec);
      const v = await withTimeout(Promise.resolve(generator.validate(built.buffer, built.validationSpec, ctx)), this.generationTimeoutMs, "Validation");
      const report = { passed: v.failures.length === 0, checks: v.checks, failures: v.failures, skipped: v.skipped || [] };
      if (!report.passed) throw new ArtifactError("VALIDATION_FAILURE", `The converted ${target.label} failed validation and was not saved: ${report.failures[0]}`, { validation: report });
      emit("saving", "Saving the converted artifact");
      const stored = await this.store.create({
        name: options.name || current.meta.name.replace(/\.[^.]+$/, ""), format: target.id, buffer: built.buffer, validation: report,
        source: { method: "convert", from: src.id }, metadata: built.metadata || {}, derivedFrom: { artifactId: id, version: current.record.version },
      });
      const result = this.#result(stored, stored.versions[0], job.id);
      job.state = "succeeded"; job.finishedAt = this.now(); job.result = result;
      emit("completed", "Conversion complete", { artifactId: stored.id });
      return result;
    } catch (error) {
      return this.#fail(job, options.onEvent, error);
    } finally {
      this.sem.release();
      await this.store.cleanupTemp(tempDir);
    }
  }

  /** Optional local-AI image (Stable Diffusion). Never required for basic images. */
  async createAiImage({ prompt, width = 512, height = 512, steps, format = "png", name, onEvent }) {
    const job = this.startJob({ kind: "ai-image" });
    let tempDir;
    await this.sem.acquire();
    try {
      this.#emit(job, onEvent, "understanding", "Understanding the request");
      requireFormat(format);
      tempDir = await this.store.makeTempDir(job.id);
      this.#emit(job, onEvent, "generating", "Generating with the local Stable Diffusion engine");
      const png = await generateWithLocalSd({ prompt, width, height, steps }, { tempDir });
      this.#emit(job, onEvent, "processing", "Encoding the image");
      const buffer = format === "png" ? png : (await processImage(png, [{ op: "convert" }], format)).buffer;
      this.#emit(job, onEvent, "validating", "Validating the image");
      const v = await imageGenerators[format].validate(buffer, undefined);
      const report = { passed: v.failures.length === 0, checks: v.checks, failures: v.failures, skipped: [] };
      if (!report.passed) throw new ArtifactError("VALIDATION_FAILURE", `The generated image failed validation: ${report.failures[0]}`, { validation: report });
      this.#emit(job, onEvent, "saving", "Saving the artifact");
      const stored = await this.store.create({ name: name || "ai-image", format, buffer, validation: report, source: { method: "local-stable-diffusion", prompt: String(prompt).slice(0, 500) }, metadata: { engine: "stable-diffusion.cpp" } });
      const result = this.#result(stored, stored.versions[0], job.id);
      job.state = "succeeded"; job.finishedAt = this.now(); job.result = result;
      this.#emit(job, onEvent, "completed", "Image created and verified", { artifactId: stored.id });
      return result;
    } catch (error) {
      return this.#fail(job, onEvent, error);
    } finally {
      this.sem.release();
      await this.store.cleanupTemp(tempDir);
    }
  }


  /**
   * Cloud image generation/editing. Provider bytes pass the same validation and
   * artifact-store integrity checks as every other generated image.
   */
  async createProviderImage({
    prompt, width = 1024, height = 1024, model, referenceImage,
    artifactId, artifactVersion, name, onEvent,
  }) {
    const job = this.startJob({ kind: referenceImage ? "ai-image-edit" : "ai-image" });
    let current;
    await this.sem.acquire();
    try {
      if (!this.imageRouter) throw unavailable("No cloud image provider is configured.");
      this.#emit(job, onEvent, "understanding", "Understanding the image request");

      if (typeof prompt !== "string" || !prompt.trim()) throw invalid("An image prompt is required.");
      if (artifactId && !referenceImage) throw invalid("An artifact ID can only be supplied when editing a reference image.");

      // Uploaded references create a new artifact; stored references create a new version.
      if (referenceImage && artifactId) {
        if (!isArtifactId(artifactId)) throw invalid("Invalid image artifact ID.");
        current = await this.store.readVersion(artifactId);
        if (current.meta.kind !== "image" || !["png", "jpg", "webp"].includes(current.meta.format)) {
          throw invalid("Only PNG, JPEG and WebP artifacts can be edited with a cloud image model.");
        }
        if (artifactVersion !== undefined && Number(artifactVersion) !== current.record.version) {
          throw new ArtifactError("CONFLICT", "This image has a newer version. Reopen the latest image before editing.");
        }
      }

      this.#emit(job, onEvent, "generating", referenceImage
        ? "Editing the reference image with the cloud provider"
        : "Generating with the cloud image provider");

      const generated = await withTimeout(
        this.imageRouter.generate({ prompt, width, height, model, referenceImage }),
        this.generationTimeoutMs,
        "Cloud image generation",
      );

      if (!generated?.buffer || !Buffer.isBuffer(generated.buffer)) {
        throw new ArtifactError("GENERATION_FAILURE", "The cloud provider returned no valid image data.");
      }

      this.#emit(job, onEvent, "validating", "Checking image format and dimensions");
      const inputMeta = await sharp(generated.buffer, {
        limitInputPixels: IMAGE_LIMITS.maxInputPixels,
        failOn: "error",
      }).metadata();

      if (!inputMeta.width || !inputMeta.height ||
          inputMeta.width > IMAGE_LIMITS.maxOutputDimension ||
          inputMeta.height > IMAGE_LIMITS.maxOutputDimension ||
          inputMeta.width * inputMeta.height > IMAGE_LIMITS.maxInputPixels) {
        throw invalid("The generated image dimensions exceed EXILE's supported limits.");
      }

      // Preserve the existing artifact's raster format on edits; new cloud images are PNG.
      const format = current
        ? current.meta.format
        : "png";
      const sharpFormat = format === "jpg" ? "jpeg" : format;
      const buffer = await sharp(generated.buffer, {
        limitInputPixels: IMAGE_LIMITS.maxInputPixels,
        failOn: "error",
      }).toFormat(sharpFormat).toBuffer();

      const validation = await imageGenerators[format].validate(buffer);
      const report = {
        passed: validation.failures.length === 0,
        checks: validation.checks,
        failures: validation.failures,
        skipped: validation.skipped || [],
      };
      if (!report.passed) {
        throw new ArtifactError("VALIDATION_FAILURE",
          `The cloud image failed validation: ${report.failures[0]}`, { validation: report });
      }

      this.#emit(job, onEvent, "saving", referenceImage
        ? "Saving a new version of the existing image"
        : "Saving the generated image");

      const source = {
        method: "pollinations",
        model: generated.model,
        operation: referenceImage ? "reference-image-edit" : "text-to-image",
        prompt: prompt.slice(0, 500),
      };
      const metadata = {
        provider: generated.provider,
        model: generated.model,
        width: inputMeta.width,
        height: inputMeta.height,
        ...(generated.pricing ? { pricing: generated.pricing } : {}),
      };

      let stored;
      let record;
      if (current) {
        stored = await this.store.addVersion(artifactId, {
          buffer, validation: report, source, metadata,
          expectedVersion: current.record.version,
        });
        record = stored.versions[stored.versions.length - 1];
      } else {
        stored = await this.store.create({
          name: name || "cloud-ai-image",
          format,
          buffer,
          validation: report,
          source,
          metadata,
        });
        record = stored.versions[0];
      }

      const result = this.#result(stored, record, job.id);
      job.state = "succeeded";
      job.finishedAt = this.now();
      job.result = result;
      this.#emit(job, onEvent, "completed", "Cloud image created and verified", {
        artifactId: stored.id,
        version: record.version,
      });
      return result;
    } catch (error) {
      return this.#fail(job, onEvent, error);
    } finally {
      this.sem.release();
    }
  }

  // ---------------------------------------------------------------- package

  /** Bundle existing artifacts into a ZIP project package with a checksummed manifest. */
  async packageArtifacts(ids, { name = "exile-project", onEvent } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) return this.#fail(this.startJob({ kind: "package" }), onEvent, invalid("Provide between 1 and 100 artifact ids."));
    const job = this.startJob({ kind: "package" });
    let tempDir;
    await this.sem.acquire();
    try {
      this.#emit(job, onEvent, "processing", `Packaging ${ids.length} artifact${ids.length === 1 ? "" : "s"}`);
      const files = [];
      const manifest = [];
      const used = new Set();
      for (const id of ids) {
        const { meta, record, buffer } = await this.store.readVersion(id);
        let path = meta.name;
        for (let n = 2; used.has(path.toLowerCase()); n++) path = path.replace(/(\.[^.]+)?$/, `-${n}$1`);
        used.add(path.toLowerCase());
        files.push({ path, data: buffer });
        manifest.push({ path, artifactId: id, version: record.version, mime: meta.mime, sizeBytes: record.sizeBytes, sha256: record.sha256 });
      }
      files.push({ path: "manifest.json", data: Buffer.from(JSON.stringify({ name, createdAt: new Date(this.now()).toISOString(), files: manifest }, null, 2)) });
      tempDir = await this.store.makeTempDir(job.id);
      const buffer = makeZip(files);
      this.#emit(job, onEvent, "validating", "Validating the package");
      const v = await archiveGenerators.zip.validate(buffer, undefined);
      const report = { passed: v.failures.length === 0, checks: v.checks, failures: v.failures, skipped: [] };
      if (!report.passed) throw new ArtifactError("VALIDATION_FAILURE", `The package failed validation: ${report.failures[0]}`, { validation: report });
      this.#emit(job, onEvent, "saving", "Saving the package");
      const stored = await this.store.create({ name, format: "zip", buffer, validation: report, source: { method: "package", artifactIds: ids }, metadata: { entries: files.length } });
      const result = this.#result(stored, stored.versions[0], job.id);
      job.state = "succeeded"; job.finishedAt = this.now(); job.result = result;
      this.#emit(job, onEvent, "completed", "Package created", { artifactId: stored.id });
      return result;
    } catch (error) {
      return this.#fail(job, onEvent, error);
    } finally {
      this.sem.release();
      await this.store.cleanupTemp(tempDir);
    }
  }

  // ---------------------------------------------------------------- preview

  /** A bounded, client-safe description of the artifact's content. Never exposes file paths. */
  async preview(id, version) {
    const { meta, record, buffer } = await this.store.readVersion(id, version);
    const f = getFormat(meta.format);
    const base = { artifactId: id, version: record.version, kind: f.preview, mime: meta.mime, name: meta.name, sizeBytes: record.sizeBytes, fileUri: `/artifacts/${id}/download?inline=1&version=${record.version}` };
    if (["image", "pdf", "audio", "video"].includes(f.preview)) {
      if (f.preview === "image" && f.id !== "svg") {
        const m = await sharp(buffer, { failOn: "none" }).metadata();
        return { ...base, width: m.width, height: m.height };
      }
      if (f.id === "svg") return { ...base, width: undefined, text: undefined };
      return base;
    }
    if (f.preview === "text" || f.preview === "html") {
      if (f.id === "docx") return { ...base, kind: "text", text: docxText(buffer).slice(0, 20_000) };
      return { ...base, text: buffer.toString("utf8").slice(0, 20_000), truncated: buffer.length > 20_000 };
    }
    if (f.preview === "table") {
      if (f.id === "csv") {
        const rows = parseCsv(buffer.toString("utf8"));
        return { ...base, sheets: [{ name: "CSV", rows: rows.slice(0, 50), totalRows: rows.length }] };
      }
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      return { ...base, sheets: wb.worksheets.slice(0, 5).map((ws) => ({
        name: ws.name, totalRows: ws.actualRowCount,
        rows: Array.from({ length: Math.min(50, ws.rowCount) }, (_, r) => Array.from({ length: Math.min(20, ws.columnCount) }, (_, c) => cellText(ws.getCell(r + 1, c + 1).value))),
      })) };
    }
    if (f.preview === "slides") {
      const files = readZipChecked(buffer);
      const slides = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        .map((n) => (utf8(files.get(n)).match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, "")).join(" ").slice(0, 400));
      return { ...base, slides };
    }
    if (f.preview === "archive") {
      const files = readZipChecked(buffer);
      return { ...base, entries: [...files.entries()].slice(0, 200).map(([path, data]) => ({ path, sizeBytes: data.length })) };
    }
    return base;
  }

  /** Whether the file may be served inline to the renderer without letting it run script. */
  inlineAllowed(mime) {
    return INLINE_SAFE_MIMES.has(mime);
  }

  // --------------------------------------------------------------- delivery

  /**
   * Hand an artifact to a delivery channel. The state is "sent" only after the channel's sender
   * reports success; otherwise "failed" with the reason. The artifact is kept either way.
   */
  async deliver(id, { channel = "whatsapp", to, caption = "", version, onEvent } = {}) {
    const job = this.startJob({ kind: "deliver", artifactId: id });
    const emit = (stage, message, extra) => this.#emit(job, onEvent, stage, message, extra);
    try {
      const send = this.senders[channel];
      if (typeof send !== "function") throw unavailable(`Delivery channel "${String(channel).slice(0, 20)}" is not connected.`);
      const current = await this.store.readVersion(id, version);
      const f = getFormat(current.meta.format);
      const check = deliverability(f, current.record);
      if (check) throw check;
      const rec = await this.beginDelivery(id, { channel, to });
      emit("delivering", "Sending the attachment", { deliveryId: rec.id });
      try {
        const dataUrl = `data:${f.mime};base64,${current.buffer.toString("base64")}`;
        const out = await send({ to, dataUrl, filename: current.meta.name, caption });
        if (!out || out.sent !== true) throw new ArtifactError("DELIVERY_FAILURE", "The channel did not confirm delivery.");
        await this.store.updateDelivery(id, rec.id, { state: "sent" });
        emit("completed", "Delivered", { deliveryId: rec.id });
        job.state = "succeeded"; job.finishedAt = this.now();
        return { success: true, state: "sent", deliveryId: rec.id, artifactId: id, channel };
      } catch (error) {
        const msg = redact(error.message);
        await this.store.updateDelivery(id, rec.id, { state: "failed", error: msg });
        emit("failed", msg, { deliveryId: rec.id });
        job.state = "failed"; job.finishedAt = this.now();
        return { success: false, state: "failed", deliveryId: rec.id, artifactId: id, channel, code: "DELIVERY_FAILURE", error: msg, artifactRetained: true };
      }
    } catch (error) {
      return this.#fail(job, onEvent, error);
    }
  }

  /** Create a queued delivery record. Used by deliver() and by the WhatsApp conversation hook. */
  async beginDelivery(id, { channel, to }) {
    return this.store.addDelivery(id, { channel, target: to, state: "queued" });
  }

  async finishDelivery(id, deliveryId, { sent, error }) {
    return this.store.updateDelivery(id, deliveryId, sent ? { state: "sent" } : { state: "failed", error: error || "delivery failed" });
  }

  /** Can this artifact go to WhatsApp, and if not, why not? (used before generating for a chat) */
  whatsappEligibility(formatId) {
    const f = getFormat(formatId);
    if (!f) return { ok: false, reason: "Unknown format." };
    if (!f.whatsapp) return { ok: false, reason: `${f.label} files can't be sent through WhatsApp by EXILE's current sender.` };
    return { ok: true };
  }
}

// ------------------------------------------------------------------- helpers

function deliverability(f, record) {
  if (!f.whatsapp) return new ArtifactError("INVALID_INPUT", `${f.label} can't be sent through WhatsApp by EXILE's current sender (it carries images, PDF, text, CSV, Office and audio files). Convert it first.`);
  if (record.sizeBytes > WHATSAPP_MAX_BYTES) return new ArtifactError("TOO_LARGE", `The file is ${(record.sizeBytes / 1048576).toFixed(1)} MB; WhatsApp attachments are limited to 15 MB.`);
  if (!record.validation?.passed) return new ArtifactError("FORBIDDEN", "Only validated artifacts can be delivered.");
  return null;
}

function summary(m) {
  const v = m.versions[m.versions.length - 1];
  return {
    artifactId: m.id, name: m.name, format: m.format, mimeType: m.mime, kind: m.kind, extension: m.ext,
    sizeBytes: v.sizeBytes, version: m.currentVersion, versions: m.versions.length, createdAt: m.createdAt, updatedAt: m.updatedAt,
    validated: !!v.validation?.passed, previewUri: `/artifacts/${m.id}/preview`, downloadUri: `/artifacts/${m.id}/download`,
    whatsappDeliverable: !!FORMATS[m.format].whatsapp && v.sizeBytes <= WHATSAPP_MAX_BYTES,
    deliveries: m.deliveries.slice(-5).map((d) => ({ id: d.id, channel: d.channel, state: d.state, queuedAt: d.queuedAt, finishedAt: d.finishedAt, error: d.error })),
  };
}

/** Keep a bounded, secret-free copy of the spec so procedural images can be varied later. */
function storableSource(spec, fmt) {
  if (fmt.kind === "image" && spec?.procedural) {
    const text = JSON.stringify(spec.procedural);
    if (text.length <= MAX_STORED_SPEC_CHARS) return { procedural: spec.procedural };
  }
  return {};
}

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return v instanceof Date ? v.toISOString() : String(v.result ?? v.text ?? (v.formula ? `=${v.formula}` : ""));
  return String(v);
}

function docxText(buffer) {
  const files = readZipChecked(buffer);
  const xml = files.get("word/document.xml");
  if (!xml) return "";
  return utf8(xml).replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

/** Turn provider text into the declarative spec for a format. */
export function specFromContent(formatId, text, request) {
  const t = String(text);
  switch (formatId) {
    case "svg": case "png": case "jpg": case "webp": {
      const m = /<svg[\s\S]*<\/svg>/i.exec(t);
      if (!m) throw invalid("The provider did not return an SVG image.");
      return { svg: m[0] };
    }
    case "mp4": case "webm": return { text: cleanContent(t), title: String(request).slice(0, 80), captions: true, transition: "fade" };
    case "mp3": case "wav": case "ogg": case "m4a": return { text: cleanContent(t) };
    case "zip": {
      let parsed;
      try { parsed = JSON.parse(cleanContent(t).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw invalid("The provider did not return valid JSON for the project files."); }
      if (!Array.isArray(parsed?.files)) throw invalid("The project JSON has no `files` array.");
      return { files: parsed.files, projectName: "exile-project" };
    }
    default: return { content: t };
  }
}

async function resolveOverlays(operations, engine) {
  const out = [];
  for (const op of operations) {
    if (op.op === "composite" && typeof op.overlayArtifactId === "string") {
      const o = await engine.store.readVersion(op.overlayArtifactId);
      if (o.meta.kind !== "image") throw invalid("The overlay artifact must be an image.");
      out.push({ ...op, overlay: o.buffer });
    } else out.push(op);
  }
  return out;
}

async function editVideo(buffer, fmt, operations, ctx, engine) {
  let current = buffer;
  let curExt = fmt.ext;
  for (const op of operations) {
    if (op.op === "trim") current = await trimVideo(current, curExt, fmt.id, op, ctx);
    else if (op.op === "convert" || op.op === "resize") current = await convertVideo(current, curExt, fmt.id, op, ctx);
    else if (op.op === "addAudio") {
      const a = await engine.store.readVersion(op.audioArtifactId);
      if (a.meta.kind !== "audio") throw invalid("addAudio needs an audio artifact id.");
      current = await addAudioToVideo(current, curExt, a.buffer, a.meta.ext, fmt.id, { volume: op.volume ?? 1, tempDir: ctx.tempDir });
    } else if (op.op === "join") {
      const parts = [{ buffer: current, ext: curExt }];
      for (const pid of op.artifactIds || []) {
        const p = await engine.store.readVersion(pid);
        if (p.meta.kind !== "video") throw invalid("join only accepts video artifacts.");
        parts.push({ buffer: p.buffer, ext: p.meta.ext });
      }
      current = await joinVideos(parts, fmt.id, { width: op.width, height: op.height, fps: op.fps, tempDir: ctx.tempDir });
    } else throw invalid(`Unknown video operation "${String(op.op).slice(0, 30)}". Use trim, convert, resize, addAudio or join.`);
    curExt = fmt.ext;
  }
  return current;
}

const CONVERSIONS_DESCRIPTION = [
  "image <-> image (PNG, JPEG, WebP; SVG to raster)",
  "audio <-> audio (WAV, MP3, Ogg, M4A); video -> audio (extract)",
  "video -> video (MP4, WebM, resize); video -> PNG (frame)",
  "DOCX/RTF/PPTX/XLSX -> PDF (needs LibreOffice)",
  "Markdown/text -> PDF, DOCX, HTML, RTF, TXT, MD",
  "PDF/DOCX -> TXT (text extraction)",
  "CSV <-> XLSX, CSV <-> JSON, XLSX -> CSV",
];

const TEXT_SOURCES = new Set(["md", "txt"]);
const TEXT_TARGETS = new Set(["pdf", "docx", "html", "rtf", "txt", "md"]);

async function convertBuffer(buffer, src, target, options, ctx) {
  // images
  if (src.kind === "image" && target.kind === "image") {
    if (target.id === "svg") throw invalid("Raster images can't be converted to SVG.");
    const out = (await processImage(buffer, [{ op: "convert" }], target.id, { quality: options.quality })).buffer;
    return { buffer: out, metadata: {}, validationSpec: undefined };
  }
  // audio / video
  if (src.kind === "audio" && target.kind === "audio") return { buffer: await convertAudio(buffer, src.ext, target.id, ctx), metadata: {}, validationSpec: { allowSilence: true } };
  if (src.kind === "video" && target.kind === "audio") return { buffer: await extractAudio(buffer, src.ext, target.id, ctx), metadata: {}, validationSpec: { allowSilence: true } };
  if (src.kind === "video" && target.kind === "video") return { buffer: await convertVideo(buffer, src.ext, target.id, options, ctx), metadata: {}, validationSpec: undefined };
  if (src.kind === "video" && target.id === "png") return { buffer: await extractFrame(buffer, src.ext, options, ctx), metadata: {}, validationSpec: undefined };
  // office -> pdf
  if (target.id === "pdf" && ["docx", "rtf", "pptx", "xlsx"].includes(src.id)) {
    const r = await convertWithOffice(buffer, src.ext, "pdf", ctx.tempDir);
    if (!r.available) throw unavailable(`Converting ${src.label} to PDF needs LibreOffice (${r.reason}).`);
    return { buffer: r.output, metadata: {}, validationSpec: undefined };
  }
  // documents -> plain text
  if (target.id === "txt" && src.id === "pdf") {
    const t = await extractPdfText(buffer, { maxPages: 200 });
    if (!t || !t.text.trim()) throw invalid("No text could be extracted from the PDF.");
    const spec = { content: t.pages.join("\n\n") };
    const built = await documentGenerators.txt.generate(spec, ctx);
    return { buffer: built.buffer, metadata: { pages: t.numPages }, validationSpec: undefined, spec };
  }
  if (target.id === "txt" && src.id === "docx") {
    const text = docxText(buffer);
    if (!text.trim()) throw invalid("The Word document has no text.");
    return { buffer: Buffer.from(text + "\n", "utf8"), metadata: {}, validationSpec: undefined };
  }
  // text -> documents
  if (TEXT_SOURCES.has(src.id) && TEXT_TARGETS.has(target.id)) {
    const content = buffer.toString("utf8");
    const spec = { content };
    const built = await pickGenerator(target.id, spec).generate(spec, ctx);
    return { buffer: built.buffer, metadata: built.metadata, validationSpec: spec, spec };
  }
  // data
  if (src.id === "csv" && target.id === "xlsx") {
    const spec = { content: buffer.toString("utf8") };
    const built = await dataGenerators.xlsx.generate(spec, ctx);
    return { buffer: built.buffer, metadata: built.metadata, validationSpec: spec, spec };
  }
  if (src.id === "csv" && target.id === "json") {
    const rows = parseCsv(buffer.toString("utf8"));
    const [header, ...body] = rows;
    const spec = { data: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
    const built = await dataGenerators.json.generate(spec, ctx);
    return { buffer: built.buffer, metadata: built.metadata, validationSpec: spec, spec };
  }
  if (src.id === "json" && target.id === "csv") {
    let data;
    try { data = JSON.parse(buffer.toString("utf8")); } catch { throw invalid("The JSON artifact does not parse."); }
    if (!Array.isArray(data) || !data.length || !data.every((r) => r && typeof r === "object" && !Array.isArray(r))) throw invalid("Only a JSON array of objects can be converted to CSV.");
    const spec = { rows: data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v]))) };
    const built = await dataGenerators.csv.generate(spec, ctx);
    return { buffer: built.buffer, metadata: built.metadata, validationSpec: spec, spec };
  }
  if (src.id === "xlsx" && target.id === "csv") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw invalid("The workbook has no sheets.");
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => { rows.push(Array.from({ length: ws.columnCount }, (_, c) => cellText(row.getCell(c + 1).value))); });
    if (!rows.length) throw invalid("The first sheet is empty.");
    return { buffer: serializeCsv(rows), metadata: { sheet: ws.name }, validationSpec: undefined };
  }
  throw invalid(`Converting ${src.label} to ${target.label} is not supported. Supported: ${CONVERSIONS_DESCRIPTION.join("; ")}.`);
}

export { STAGES, GENERATORS, concatAudio, mixAudio, planStoryboard, generationFailed };
