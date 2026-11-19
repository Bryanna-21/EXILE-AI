/**
 * Structural validation shared by every PDF the engine produces (documents and slide exports).
 */
import { PDFDocument } from "pdf-lib";
import { extractPdfText, renderPdfFirstPage } from "./render.mjs";

export async function validatePdfStructure(buffer, ctx) {
  const checks = [];
  const failures = [];
  const skipped = [];
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") failures.push("Missing %PDF- header.");
  else checks.push("PDF header present");
  if (!buffer.subarray(Math.max(0, buffer.length - 1100)).toString("latin1").includes("%%EOF")) failures.push("Missing %%EOF trailer.");
  else checks.push("PDF trailer present");
  let pageCount = 0;
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    pageCount = doc.getPageCount();
    if (pageCount < 1) failures.push("PDF has no pages.");
    else checks.push(`PDF structure parses (${pageCount} page${pageCount === 1 ? "" : "s"})`);
  } catch (error) {
    failures.push(`PDF structure is invalid: ${error.message}`);
  }
  if (failures.length) return { checks, failures, skipped, pageCount, text: null };

  let text = null;
  try {
    text = await extractPdfText(buffer);
  } catch (error) {
    failures.push(`PDF text could not be read back: ${error.message}`);
  }
  if (text) {
    if (text.numPages !== pageCount) failures.push("pdf.js and pdf-lib disagree on the page count.");
    else if (!text.text.replace(/\s+/g, "").length) failures.push("PDF contains no extractable text.");
    else checks.push("PDF text is extractable");
  } else if (text === null && !failures.length) skipped.push("text extraction (pdf.js unavailable)");

  const render = await renderPdfFirstPage(buffer, ctx.tempDir);
  if (render.available) {
    if (render.nonWhitePixels < 20) failures.push("Rendered page 1 is blank.");
    else checks.push("Page 1 renders with visible content");
  } else skipped.push(`page rendering (${render.reason})`);
  return { checks, failures, skipped, pageCount, text };
}
