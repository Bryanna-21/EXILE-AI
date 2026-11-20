/**
 * Optional "deep" validation helpers that render a result with real tools.
 * They report `available:false` when the tool is missing or fails to run, so a
 * validator can list the check as skipped instead of claiming it passed.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { findTool, runTool } from "./tools.mjs";

export function deepRenderEnabled() {
  return process.env.EXILE_ARTIFACT_DEEP_RENDER !== "0";
}

/**
 * Convert a document with LibreOffice (headless) to another format.
 * Returns { available:false, reason } when LibreOffice is absent or does not finish,
 * { available:true, output } (a Buffer) otherwise.
 */
export async function convertWithOffice(buffer, ext, target, tempDir, { timeoutMs = 90_000 } = {}) {
  const soffice = findTool("soffice");
  if (!soffice || !deepRenderEnabled()) return { available: false, reason: soffice ? "disabled" : "LibreOffice not installed" };
  const work = path.join(tempDir, `render-${crypto.randomBytes(4).toString("hex")}`);
  await fsp.mkdir(work, { recursive: true });
  const input = path.join(work, `input.${ext}`);
  const profile = path.join(work, "profile");
  await fsp.writeFile(input, buffer);
  try {
    const run = await runTool(soffice, [
      "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
      `-env:UserInstallation=file://${profile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`,
      "--convert-to", target, "--outdir", work, input,
    ], { timeoutMs, cwd: work });
    try {
      return { available: true, output: await fsp.readFile(path.join(work, `input.${target}`)) };
    } catch {
      return { available: false, reason: `LibreOffice did not produce a ${target} file (exit ${run.code})` };
    }
  } catch (error) {
    return { available: false, reason: error.message };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Convert to PDF with LibreOffice and count pages. */
export async function renderToPdfWithOffice(buffer, ext, tempDir, options) {
  const converted = await convertWithOffice(buffer, ext, "pdf", tempDir, options);
  if (!converted.available) return converted;
  try {
    const doc = await PDFDocument.load(converted.output, { ignoreEncryption: true });
    return { available: true, pages: doc.getPageCount(), pdf: converted.output };
  } catch (error) {
    return { available: true, pages: 0, error: error.message };
  }
}

/** Render page 1 of a PDF with pdftoppm and report whether it contains non-white content. */
export async function renderPdfFirstPage(buffer, tempDir) {
  const tool = findTool("pdftoppm");
  if (!tool || !deepRenderEnabled()) return { available: false, reason: tool ? "disabled" : "pdftoppm not installed" };
  const work = path.join(tempDir, `pdfr-${crypto.randomBytes(4).toString("hex")}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const input = path.join(work, "in.pdf");
    await fsp.writeFile(input, buffer);
    const run = await runTool(tool, ["-r", "36", "-f", "1", "-l", "1", "-gray", input, path.join(work, "out")], { timeoutMs: 30_000, cwd: work });
    const files = (await fsp.readdir(work)).filter((f) => f.startsWith("out") && f.endsWith(".pgm"));
    if (run.code !== 0 || !files.length) return { available: false, reason: `pdftoppm failed (exit ${run.code})` };
    const pgm = await fsp.readFile(path.join(work, files[0]));
    // Binary PGM (P5): header "P5\nW H\n255\n" followed by W*H bytes.
    const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(pgm.subarray(0, 40).toString("latin1"));
    if (!header) return { available: false, reason: "unexpected pdftoppm output" };
    const data = pgm.subarray(header[0].length);
    let dark = 0;
    for (let i = 0; i < data.length; i++) if (data[i] < 200) dark++;
    return { available: true, width: Number(header[1]), height: Number(header[2]), nonWhitePixels: dark };
  } catch (error) {
    return { available: false, reason: error.message };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Extract text from a PDF buffer with pdf.js. Returns null if pdf.js cannot be loaded. */
export async function extractPdfText(buffer, { maxPages = 50 } = {}) {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return null;
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((i) => i.str).join(" "));
    }
    return { numPages: doc.numPages, text: pages.join("\n"), pages };
  } finally {
    await task.destroy();
  }
}
