/**
 * Presentation generators: PPTX (pptxgenjs) and PDF slide exports (pdf-lib).
 *
 * Both are driven by the same slide model so the PDF export always matches the deck.
 * Text fit is planned with a width-based estimate, then re-checked against the geometry
 * actually written into the PPTX XML by the validator.
 */
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseMarkdown, runsToText, cleanContent, toWinAnsi } from "./markdown.mjs";
import { invalid } from "./errors.mjs";
import { readZipChecked, utf8 } from "./zip-utils.mjs";
import { validateOoxml } from "./documents.mjs";
import { renderToPdfWithOffice } from "./render.mjs";
import { validatePdfStructure } from "./pdf-checks.mjs";

const MAX_SLIDES = 100;
const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = 7.5;
const BODY = { x: 0.7, y: 1.55, w: 11.93, h: 5.3 };
const FONT_STEPS = [24, 22, 20, 18, 16];
const MIN_SPLIT_FONT = 16;

// --------------------------------------------------------------- slide model

/** Accepts { slides: [...] } or markdown content; returns normalized slides. */
export function prepareDeck(spec) {
  let slides;
  let deckTitle = String(spec.title || "").slice(0, 200);
  if (Array.isArray(spec.slides)) {
    slides = spec.slides.map((s, i) => normalizeSlide(s, i));
  } else if (typeof spec.content === "string") {
    const parsed = fromMarkdown(spec.content);
    slides = parsed.slides;
    deckTitle = deckTitle || parsed.title;
  } else {
    throw invalid("Provide `slides` or markdown `content` for a presentation.");
  }
  if (!slides.length) throw invalid("The presentation has no slides.");
  if (slides.length > MAX_SLIDES) throw invalid(`At most ${MAX_SLIDES} slides are supported.`);
  return { title: deckTitle, slides, author: String(spec.author || "EXILE AI").slice(0, 100) };
}

function normalizeSlide(s, index) {
  if (!s || typeof s !== "object") throw invalid(`Slide ${index + 1} must be an object.`);
  const bullets = (Array.isArray(s.bullets) ? s.bullets : []).map((b) => (typeof b === "string" ? { text: b, level: 0 } : { text: String(b?.text ?? ""), level: Math.min(2, Math.max(0, Number(b?.level) || 0)) }))
    .filter((b) => b.text.trim());
  const table = s.table && Array.isArray(s.table.header) && Array.isArray(s.table.rows)
    ? { header: s.table.header.map((c) => String(c)), rows: s.table.rows.map((r) => r.map((c) => String(c ?? ""))) }
    : null;
  return {
    layout: s.layout === "title" || s.layout === "section" ? s.layout : "content",
    title: String(s.title || "").slice(0, 200),
    subtitle: s.subtitle ? String(s.subtitle).slice(0, 300) : "",
    bullets,
    notes: s.notes ? String(s.notes).slice(0, 4000) : "",
    table,
    image: s.image && s.image.data ? { data: s.image.data, ext: s.image.ext } : null,
  };
}

function fromMarkdown(markdown) {
  const blocks = parseMarkdown(cleanContent(markdown));
  const h1 = blocks.filter((b) => b.type === "heading" && b.level === 1);
  const hasH2 = blocks.some((b) => b.type === "heading" && b.level === 2);
  // One H1 plus H2 sections: H1 is the deck title and each H2 is a slide.
  // Otherwise each top-level heading is a slide.
  const slideLevel = h1.length === 1 && hasH2 ? 2 : (h1.length ? 1 : 2);
  const slides = [];
  let title = "";
  let current = null;
  const flush = () => { if (current) slides.push(current); current = null; };
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1 && slideLevel === 2) {
      title = runsToText(b.runs);
      continue;
    }
    if (b.type === "heading" && b.level <= slideLevel) {
      flush();
      current = normalizeSlide({ title: runsToText(b.runs), bullets: [] }, slides.length);
      continue;
    }
    if (!current) current = normalizeSlide({ title: title || "Overview", bullets: [] }, slides.length);
    if (b.type === "heading") current.bullets.push({ text: runsToText(b.runs), level: 0, bold: true });
    else if (b.type === "paragraph" || b.type === "quote") {
      const text = runsToText(b.runs);
      if (/^notes?:\s*/i.test(text)) current.notes += (current.notes ? "\n" : "") + text.replace(/^notes?:\s*/i, "");
      else current.bullets.push({ text, level: 0 });
    } else if (b.type === "list") for (const it of b.items) current.bullets.push({ text: runsToText(it.runs), level: it.level });
    else if (b.type === "table") current.table = { header: b.header.map(runsToText), rows: b.rows.map((r) => r.map(runsToText)) };
    else if (b.type === "code") current.bullets.push({ text: b.text.split("\n").slice(0, 8).join(" / "), level: 0 });
  }
  flush();
  if (title && slides.length && slides[0].title !== title) {
    slides.unshift(normalizeSlide({ layout: "title", title, subtitle: "" }, 0));
  } else if (slides.length && !slides[0].bullets.length && !slides[0].table) slides[0].layout = "title";
  return { title: title || slides[0]?.title || "", slides };
}

// ------------------------------------------------------------- text fitting

const AVG_CHAR_EM = 0.52; // average glyph width in em for a sans-serif face
const LINE_SPACING = 1.2;
const PARA_GAP_EM = 0.45;

/** Estimated height (inches) of paragraphs [{text,sizePt}] wrapped into widthIn. */
export function estimateTextHeightIn(paragraphs, widthIn) {
  let pts = 0;
  for (const p of paragraphs) {
    const widthPt = Math.max(10, widthIn * 72 - (p.indentPt || 0));
    const perLine = Math.max(4, Math.floor(widthPt / (p.sizePt * AVG_CHAR_EM)));
    const words = String(p.text).split(/\s+/);
    let lines = 1;
    let len = 0;
    for (const w of words) {
      const add = (len ? 1 : 0) + w.length;
      if (len + add > perLine && len > 0) { lines++; len = w.length; } else len += add;
      while (len > perLine) { lines++; len -= perLine; }
    }
    pts += lines * p.sizePt * LINE_SPACING + p.sizePt * PARA_GAP_EM;
  }
  return pts / 72;
}

const bulletParagraphs = (bullets, size) => bullets.map((b) => ({ text: b.text, sizePt: b.level ? size - 2 : size, indentPt: 24 + b.level * 22 }));

function fitBullets(bullets, widthIn, heightIn) {
  for (const size of FONT_STEPS) {
    if (estimateTextHeightIn(bulletParagraphs(bullets, size), widthIn) <= heightIn) return { size, fits: true };
  }
  return { size: FONT_STEPS[FONT_STEPS.length - 1], fits: false };
}

/** Expand slides so that nothing overflows: split long bullet lists and long tables. */
export function planSlides(slides, { hasImageWidth = 5.2 } = {}) {
  const out = [];
  for (const s of slides) {
    if (s.layout !== "content") { out.push({ ...s, fontSize: 0 }); continue; }
    const textW = s.image ? BODY.w - hasImageWidth - 0.3 : BODY.w;
    if (s.table) {
      const perPage = 9;
      const rows = s.table.rows;
      for (let i = 0, part = 0; i < Math.max(rows.length, 1); i += perPage, part++) {
        out.push({ ...s, title: part ? `${s.title} (cont.)` : s.title, table: { header: s.table.header, rows: rows.slice(i, i + perPage) }, bullets: part ? [] : s.bullets.slice(0, 3), notes: part ? "" : s.notes, image: null, fontSize: 14 });
      }
      continue;
    }
    if (!s.bullets.length) { out.push({ ...s, fontSize: 20 }); continue; }
    let remaining = s.bullets;
    let part = 0;
    while (remaining.length) {
      // Take as many bullets as fit at the minimum split size, then pick the largest font that fits them.
      let take = remaining.length;
      while (take > 1 && estimateTextHeightIn(bulletParagraphs(remaining.slice(0, take), MIN_SPLIT_FONT), textW) > BODY.h) take--;
      const chunk = remaining.slice(0, take);
      const fit = fitBullets(chunk, textW, BODY.h);
      out.push({ ...s, title: part ? `${s.title} (cont.)` : s.title, bullets: chunk, notes: part ? "" : s.notes, image: part ? null : s.image, fontSize: fit.size, fits: fit.fits });
      remaining = remaining.slice(take);
      part++;
    }
  }
  if (out.length > MAX_SLIDES) throw invalid(`The deck would need ${out.length} slides after fitting; the limit is ${MAX_SLIDES}.`);
  return out;
}

// ------------------------------------------------------------------- PPTX

const COLORS = { ink: "1B1F24", accent: "0B4FB3", soft: "E6EDF7", muted: "5B6573" };

function imageDataUri(image) {
  const ext = String(image.ext || "").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : null;
  if (!mime) throw invalid("Slide images must be PNG or JPEG.");
  return `${mime};base64,${Buffer.from(image.data).toString("base64")}`;
}

async function generatePptx(spec) {
  const deck = prepareDeck(spec);
  const slides = planSlides(deck.slides);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
  pptx.author = deck.author;
  pptx.title = deck.title || "EXILE AI presentation";
  pptx.company = "EXILE AI";

  const plan = [];
  slides.forEach((s) => {
    const slide = pptx.addSlide();
    if (s.notes) slide.addNotes(s.notes);
    if (s.layout === "title" || s.layout === "section") {
      slide.background = { color: s.layout === "title" ? "0F2A52" : "EEF3FA" };
      const light = s.layout === "title";
      slide.addText(s.title || deck.title || "Untitled", { x: 0.9, y: 2.3, w: 11.5, h: 1.6, fontFace: "Calibri", fontSize: 40, bold: true, color: light ? "FFFFFF" : COLORS.ink, valign: "middle", fit: "shrink" });
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.9, y: 4.0, w: 11.5, h: 1.0, fontFace: "Calibri", fontSize: 22, color: light ? "C9D6EA" : COLORS.muted, valign: "top" });
      plan.push({ title: s.title, layout: s.layout, fontSize: 40 });
      return;
    }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W_IN, h: 0.18, fill: { color: COLORS.accent }, line: { color: COLORS.accent } });
    slide.addText(s.title || "", { x: 0.7, y: 0.4, w: 11.93, h: 0.95, fontFace: "Calibri", fontSize: 32, bold: true, color: COLORS.ink, valign: "middle", fit: "shrink" });
    let hasImage = false;
    if (s.image) {
      hasImage = true;
      slide.addImage({ data: imageDataUri(s.image), x: BODY.x + BODY.w - 5.2, y: BODY.y, w: 5.2, h: BODY.h, sizing: { type: "contain", w: 5.2, h: BODY.h } });
    }
    const textW = hasImage ? BODY.w - 5.5 : BODY.w;
    if (s.table) {
      let ty = BODY.y;
      if (s.bullets.length) {
        slide.addText(s.bullets.map((b) => ({ text: b.text, options: { bullet: true, breakLine: true } })), { x: BODY.x, y: ty, w: textW, h: 1.2, fontFace: "Calibri", fontSize: 18, color: COLORS.ink, valign: "top" });
        ty += 1.3;
      }
      const head = s.table.header.map((c) => ({ text: c, options: { bold: true, fill: { color: COLORS.soft }, color: COLORS.ink } }));
      const body = s.table.rows.map((r) => r.map((c) => ({ text: c })));
      slide.addTable([head, ...body], { x: BODY.x, y: ty, w: textW, fontFace: "Calibri", fontSize: 14, color: COLORS.ink, border: { type: "solid", color: "C9CED6", pt: 0.75 }, valign: "middle", autoPage: false });
    } else if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b.text, options: { bullet: !b.bold, bold: !!b.bold, indentLevel: b.level, breakLine: true, fontSize: b.level ? s.fontSize - 2 : s.fontSize, paraSpaceAfter: 6 } })),
        { x: BODY.x, y: BODY.y, w: textW, h: BODY.h, fontFace: "Calibri", color: COLORS.ink, valign: "top" },
      );
    }
    plan.push({ title: s.title, layout: "content", fontSize: s.fontSize, bullets: s.bullets.length, table: !!s.table, image: hasImage, fits: s.fits !== false });
  });
  const out = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(out) ? out : Buffer.from(out);
  return { buffer, metadata: { slides: plan.length, planned: plan, title: deck.title } };
}

const EMU_PER_INCH = 914400;

async function validatePptx(buffer, spec, ctx) {
  const base = await validateOoxml(buffer, {
    required: ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"], mainPart: "ppt/presentation.xml", ext: "pptx",
  }, ctx);
  const { checks, failures, skipped, files } = base;
  if (failures.length) return { checks, failures, skipped };
  const slideNames = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  let expected = null;
  if (spec) {
    try { expected = planSlides(prepareDeck(spec).slides); } catch (error) { return { checks, failures: [error.message], skipped }; }
    if (slideNames.length !== expected.length) failures.push(`Expected ${expected.length} slides but the file has ${slideNames.length}.`);
    else checks.push(`Slide count matches (${slideNames.length})`);
  } else if (!slideNames.length) failures.push("The presentation has no slides.");

  // Re-measure the text boxes that were actually written, not the plan.
  let overflow = 0;
  let missingTitle = 0;
  slideNames.forEach((name, i) => {
    const xml = utf8(files.get(name));
    const sps = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
    for (const sp of sps) {
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(sp);
      const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp);
      if (!ext || !body || /<a:normAutofit/.test(body[1])) continue; // shrink-on-overflow boxes manage themselves
      const widthIn = Number(ext[1]) / EMU_PER_INCH;
      const heightIn = Number(ext[2]) / EMU_PER_INCH;
      const paras = (body[1].match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((p) => {
        const size = /<a:rPr[^>]*\bsz="(\d+)"/.exec(p);
        const marL = /marL="(\d+)"/.exec(p);
        const text = (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, "")).join("");
        return { text: text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), sizePt: size ? Number(size[1]) / 100 : 18, indentPt: marL ? Number(marL[1]) / 12700 : 0 };
      }).filter((p) => p.text);
      if (paras.length && estimateTextHeightIn(paras, widthIn) > heightIn * 1.03) overflow++;
    }
    if (expected && expected[i]?.title) {
      const flat = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, "")).join("").replace(/&amp;/g, "&").replace(/\s+/g, "");
      if (!flat.includes(expected[i].title.replace(/\s+/g, ""))) missingTitle++;
    }
  });
  if (overflow) failures.push(`${overflow} text box${overflow === 1 ? "" : "es"} would overflow their slide.`);
  else checks.push("No text overflow in any text box");
  if (missingTitle) failures.push(`${missingTitle} slide title${missingTitle === 1 ? " is" : "s are"} missing from the slides.`);
  else if (expected) checks.push("Every slide title is present");
  if (expected?.some((s) => s.image)) {
    if ([...files.keys()].some((n) => n.startsWith("ppt/media/"))) checks.push("Embedded images are present"); else failures.push("A slide image is missing from the package.");
  }
  if (!failures.length) {
    const render = await renderToPdfWithOffice(buffer, "pptx", ctx.tempDir);
    if (render.available) {
      if (render.pages !== slideNames.length) failures.push(`LibreOffice rendered ${render.pages} pages for ${slideNames.length} slides.`);
      else checks.push(`Renders in LibreOffice (${render.pages} slide${render.pages === 1 ? "" : "s"})`);
    } else skipped.push(`slide rendering (${render.reason})`);
  }
  return { checks, failures, skipped };
}

// ------------------------------------------------------------- PDF slides

const PW = 960;
const PH = 540;

async function generateSlidePdf(spec) {
  const deck = prepareDeck(spec);
  const slides = planSlides(deck.slides);
  const doc = await PDFDocument.create();
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
  const ink = rgb(0.106, 0.122, 0.141);
  const accent = rgb(0.043, 0.31, 0.7);

  const wrap = (text, font, size, width) => {
    const lines = [];
    let line = "";
    for (const word of toWinAnsi(text).split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= width || !line) line = test; else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };

  const imageEmbeds = new Map();
  for (const s of slides) {
    if (s.image && !imageEmbeds.has(s.image)) {
      const bytes = Buffer.from(s.image.data);
      const ext = String(s.image.ext).toLowerCase();
      imageEmbeds.set(s.image, ext === "png" ? await doc.embedPng(bytes) : ext === "jpg" || ext === "jpeg" ? await doc.embedJpg(bytes) : (() => { throw invalid("Slide images must be PNG or JPEG."); })());
    }
  }

  const meta = [];
  for (const s of slides) {
    const page = doc.addPage([PW, PH]);
    if (s.layout === "title" || s.layout === "section") {
      const dark = s.layout === "title";
      page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: dark ? rgb(0.059, 0.165, 0.322) : rgb(0.933, 0.953, 0.98) });
      let y = PH / 2 + 30;
      for (const ln of wrap(s.title || deck.title || "Untitled", F.b, 40, PW - 120)) { page.drawText(ln, { x: 60, y, size: 40, font: F.b, color: dark ? rgb(1, 1, 1) : ink }); y -= 48; }
      if (s.subtitle) for (const ln of wrap(s.subtitle, F.r, 22, PW - 120)) { y -= 8; page.drawText(ln, { x: 60, y, size: 22, font: F.r, color: dark ? rgb(0.79, 0.84, 0.92) : rgb(0.36, 0.4, 0.45) }); y -= 28; }
      meta.push({ title: s.title, layout: s.layout });
      continue;
    }
    page.drawRectangle({ x: 0, y: PH - 9, width: PW, height: 9, color: accent });
    let ty = PH - 62;
    for (const ln of wrap(s.title, F.b, 30, PW - 100)) { page.drawText(ln, { x: 50, y: ty, size: 30, font: F.b, color: ink }); ty -= 36; }
    const left = 50;
    const bodyTop = PH - 108;
    const bodyBottom = 40;
    let textWidth = PW - 100;
    if (s.image) {
      const img = imageEmbeds.get(s.image);
      const boxW = 320;
      const boxH = bodyTop - bodyBottom;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      page.drawImage(img, { x: PW - 50 - boxW + (boxW - img.width * scale) / 2, y: bodyTop - img.height * scale, width: img.width * scale, height: img.height * scale });
      textWidth = PW - 100 - boxW - 20;
    }
    let y = bodyTop;
    let overflowed = false;
    if (s.table) {
      const cols = s.table.header.length;
      const colW = textWidth / cols;
      const rowH = 26;
      const drawRow = (cells, bold, fill) => {
        if (y - rowH < bodyBottom) { overflowed = true; return; }
        page.drawRectangle({ x: left, y: y - rowH, width: textWidth, height: rowH, borderColor: rgb(0.78, 0.8, 0.84), borderWidth: 0.7, ...(fill ? { color: fill } : {}) });
        cells.forEach((c, i) => {
          const text = wrap(c, bold ? F.b : F.r, 12, colW - 12)[0];
          page.drawText(text, { x: left + i * colW + 6, y: y - 17, size: 12, font: bold ? F.b : F.r, color: ink });
        });
        y -= rowH;
      };
      if (s.bullets.length) for (const b of s.bullets) for (const ln of wrap(b.text, F.r, 16, textWidth - 20)) { y -= 22; page.drawText(`• ${ln}`, { x: left, y, size: 16, font: F.r, color: ink }); }
      y -= 10;
      drawRow(s.table.header, true, rgb(0.9, 0.93, 0.97));
      for (const r of s.table.rows) drawRow(r, false);
    } else {
      const size = s.fontSize || 20;
      for (const b of s.bullets) {
        const sz = b.level ? size - 2 : size;
        const indent = 18 + b.level * 22;
        const lines = wrap(b.text, b.bold ? F.b : F.r, sz, textWidth - indent);
        lines.forEach((ln, idx) => {
          y -= sz * 1.25;
          if (y < bodyBottom) { overflowed = true; return; }
          if (idx === 0 && !b.bold) page.drawText("•", { x: left + indent - 16, y, size: sz, font: F.r, color: accent });
          page.drawText(ln, { x: left + indent, y, size: sz, font: b.bold ? F.b : F.r, color: ink });
        });
        y -= sz * 0.45;
      }
    }
    if (overflowed) throw invalid(`Slide "${s.title}" does not fit on the page.`);
    page.drawText(`${meta.length + 1}`, { x: PW - 40, y: 16, size: 10, font: F.r, color: rgb(0.5, 0.5, 0.55) });
    meta.push({ title: s.title, layout: "content", fontSize: s.fontSize });
  }
  doc.setTitle(toWinAnsi(deck.title || "EXILE AI slides"));
  doc.setProducer("EXILE AI");
  const bytes = await doc.save({ useObjectStreams: false });
  return { buffer: Buffer.from(bytes), metadata: { slides: meta.length, planned: meta, title: deck.title } };
}

async function validateSlidePdf(buffer, spec, ctx) {
  const result = await validatePdfStructure(buffer, ctx);
  const { checks, failures, skipped } = result;
  if (failures.length) return result;
  let expected;
  try { expected = planSlides(prepareDeck(spec).slides); } catch (error) { return { checks, failures: [error.message], skipped }; }
  if (result.pageCount !== expected.length) failures.push(`Expected ${expected.length} slide pages but the PDF has ${result.pageCount}.`);
  else checks.push(`One page per slide (${expected.length})`);
  if (result.text) {
    const flat = result.text.text.replace(/\s+/g, "");
    const missing = expected.filter((s) => s.title && !flat.includes(toWinAnsi(s.title).replace(/\s+/g, ""))).length;
    if (missing) failures.push(`${missing} slide title${missing === 1 ? "" : "s"} not found in the PDF text.`);
    else checks.push("Every slide title is present in the PDF text");
  }
  return { checks, failures, skipped };
}

export const presentationGenerators = {
  pptx: { generate: generatePptx, validate: validatePptx },
  "pdf-slides": { generate: generateSlidePdf, validate: validateSlidePdf },
};

export { readZipChecked };
