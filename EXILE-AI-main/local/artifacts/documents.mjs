/**
 * Document generators: PDF, DOCX, TXT, Markdown, RTF, HTML.
 *
 * Every generator takes a normalized spec { title?, content, author? } where `content`
 * is Markdown, and every generator ships its own validator. Validators return
 * { checks, failures, skipped }: `checks` are things that were really verified,
 * `skipped` are deeper checks that could not run (e.g. LibreOffice not installed).
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ExternalHyperlink, BorderStyle, ShadingType, AlignmentType, LevelFormat,
} from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  parseMarkdown, runsToText, firstHeading, blocksToPlainText, cleanContent, toWinAnsi, isSafeUrl,
} from "./markdown.mjs";
import { readZipChecked, isWellFormedXml, utf8 } from "./zip-utils.mjs";
import { renderToPdfWithOffice } from "./render.mjs";
import { validatePdfStructure } from "./pdf-checks.mjs";
import { invalid } from "./errors.mjs";

const squash = (s) => String(s).replace(/\s+/g, "");

/** Snippets of the source that must be present in the rendered artifact. */
function expectedSnippets(blocks, convert = (s) => s) {
  const out = [];
  for (const b of blocks) {
    if (out.length >= 4) break;
    let text = "";
    if (b.type === "heading" || b.type === "paragraph") text = runsToText(b.runs);
    else if (b.type === "list" && b.items[0]) text = runsToText(b.items[0].runs);
    text = text.trim();
    if (text.length >= 3) out.push(squash(convert(text.split(/\s+/).slice(0, 6).join(" "))));
  }
  return out;
}

export function prepareDocument(spec) {
  if (spec === null || typeof spec !== "object") throw invalid("A document specification is required.");
  const content = cleanContent(spec.content);
  const blocks = parseMarkdown(content);
  if (!blocks.length) throw invalid("The document content is empty.");
  const title = String(spec.title || firstHeading(blocks) || "").slice(0, 200);
  return { title, blocks, content, author: String(spec.author || "EXILE AI").slice(0, 100) };
}

// ====================================================================== PDF

const A4 = [595.28, 841.89];

async function generatePdf(spec) {
  const { title, blocks, author } = prepareDocument(spec);
  const doc = await PDFDocument.create();
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await doc.embedFont(StandardFonts.Courier),
  };
  const M = 56;
  const W = A4[0] - 2 * M;
  const BOTTOM = M + 12;
  let page;
  let y;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - M; };
  const need = (h) => { if (!page || y - h < BOTTOM) newPage(); };
  const ink = rgb(0.1, 0.1, 0.12);
  const link = rgb(0.05, 0.3, 0.7);

  const fontFor = (run, baseBold) => {
    if (run.code) return F.m;
    const bold = baseBold || run.bold;
    if (bold && run.italic) return F.bi;
    if (bold) return F.b;
    if (run.italic) return F.i;
    return F.r;
  };

  /** Word-wrap styled runs into lines of segments. */
  const layout = (runs, size, maxWidth, baseBold = false) => {
    const lines = [];
    let line = { segs: [], width: 0 };
    const push = () => { lines.push(line); line = { segs: [], width: 0 }; };
    for (const run of runs) {
      const font = fontFor(run, baseBold);
      const color = run.href ? link : ink;
      for (const token of toWinAnsi(run.text).split(/(\s+)/)) {
        if (!token) continue;
        const isSpace = /^\s+$/.test(token);
        const text = isSpace ? " " : token;
        let w = font.widthOfTextAtSize(text, size);
        if (isSpace && !line.segs.length) continue;
        if (!isSpace && line.width + w > maxWidth && line.segs.length) push();
        if (!isSpace && w > maxWidth) {
          // A single token wider than the line: break it by characters.
          let chunk = "";
          for (const ch of text) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
              line.segs.push({ text: chunk, font, w: font.widthOfTextAtSize(chunk, size), color, underline: !!run.href });
              push();
              chunk = "";
            }
            chunk += ch;
          }
          if (chunk) {
            w = font.widthOfTextAtSize(chunk, size);
            line.segs.push({ text: chunk, font, w, color, underline: !!run.href });
            line.width += w;
          }
          continue;
        }
        line.segs.push({ text, font, w, color, underline: !!run.href });
        line.width += w;
      }
    }
    if (line.segs.length || !lines.length) {
      while (line.segs.length && line.segs[line.segs.length - 1].text === " ") { line.width -= line.segs.pop().w; }
      lines.push(line);
    }
    return lines;
  };

  const drawLine = (ln, x, size, baseY) => {
    let cx = x;
    for (const s of ln.segs) {
      page.drawText(s.text, { x: cx, y: baseY, size, font: s.font, color: s.color });
      if (s.underline) page.drawLine({ start: { x: cx, y: baseY - 1.5 }, end: { x: cx + s.w, y: baseY - 1.5 }, thickness: 0.5, color: s.color });
      cx += s.w;
    }
  };

  const paragraph = (runs, { size = 10.5, x = M, width = W, baseBold = false, gap = 6, leading = 1.4 } = {}) => {
    const lh = size * leading;
    for (const ln of layout(runs, size, width, baseBold)) {
      need(lh);
      y -= lh;
      drawLine(ln, x, size, y);
    }
    y -= gap;
  };

  if (title) {
    paragraph([{ text: title }], { size: 22, baseBold: true, gap: 4, leading: 1.25 });
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + W, y: y + 2 }, thickness: 1, color: rgb(0.75, 0.78, 0.85) });
    y -= 12;
  }

  const headingSizes = { 1: 18, 2: 15, 3: 12.5, 4: 11 };
  let skippedTitleHeading = false;

  for (const b of blocks) {
    if (b.type === "heading") {
      // The title already shows the first heading when it was derived from it.
      if (!skippedTitleHeading && title && runsToText(b.runs) === title && !spec.title) { skippedTitleHeading = true; continue; }
      const size = headingSizes[b.level] || 11;
      need(size * 2.4);
      y -= 6;
      paragraph(b.runs, { size, baseBold: true, gap: 4, leading: 1.25 });
    } else if (b.type === "paragraph") {
      paragraph(b.runs);
    } else if (b.type === "quote") {
      const lh = 10.5 * 1.4;
      const lines = layout(b.runs.map((r) => ({ ...r, italic: true })), 10.5, W - 22);
      for (const ln of lines) {
        need(lh);
        y -= lh;
        page.drawRectangle({ x: M + 4, y: y - 3, width: 2.5, height: lh, color: rgb(0.7, 0.74, 0.82) });
        drawLine(ln, M + 16, 10.5, y);
      }
      y -= 6;
    } else if (b.type === "list") {
      let n = 0;
      for (const item of b.items) {
        n += 1;
        const indent = M + 8 + item.level * 18;
        const marker = b.ordered ? `${n}.` : "•";
        const lh = 10.5 * 1.4;
        const lines = layout(item.runs, 10.5, W - (indent - M) - 16);
        lines.forEach((ln, idx) => {
          need(lh);
          y -= lh;
          if (idx === 0) page.drawText(marker, { x: indent, y, size: 10.5, font: F.r, color: ink });
          drawLine(ln, indent + 16, 10.5, y);
        });
        y -= 2;
      }
      y -= 4;
    } else if (b.type === "code") {
      const size = 9;
      const lh = 12;
      const charW = F.m.widthOfTextAtSize("M", size);
      const maxChars = Math.max(10, Math.floor((W - 16) / charW));
      const rows = [];
      for (const raw of toWinAnsi(b.text).split("\n")) {
        const line = raw.replace(/\t/g, "    ");
        if (!line.length) rows.push("");
        for (let p = 0; p < line.length; p += maxChars) rows.push(line.slice(p, p + maxChars));
      }
      for (const row of rows) {
        need(lh);
        y -= lh;
        page.drawRectangle({ x: M, y: y - 3, width: W, height: lh, color: rgb(0.95, 0.96, 0.97) });
        if (row) page.drawText(row, { x: M + 8, y, size, font: F.m, color: ink });
      }
      y -= 8;
    } else if (b.type === "hr") {
      need(14);
      y -= 8;
      page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.7, color: rgb(0.75, 0.75, 0.78) });
      y -= 8;
    } else if (b.type === "table") {
      drawTable(b);
    }
  }

  function drawTable(t) {
    const cols = t.header.length;
    const size = 9.5;
    const pad = 5;
    const lh = size * 1.35;
    const natural = [];
    for (let c = 0; c < cols; c++) {
      let max = F.b.widthOfTextAtSize(toWinAnsi(runsToText(t.header[c])), size);
      for (const row of t.rows) max = Math.max(max, F.r.widthOfTextAtSize(toWinAnsi(runsToText(row[c] || [])), size));
      natural.push(Math.min(Math.max(max + 2 * pad, 48), 260));
    }
    const sum = natural.reduce((a, b) => a + b, 0);
    const widths = natural.map((w) => (w / sum) * W);
    const heightOf = (cells, bold) => {
      let lines = 1;
      cells.forEach((cell, c) => { lines = Math.max(lines, layout(cell, size, widths[c] - 2 * pad, bold).length); });
      return lines * lh + 2 * pad;
    };
    const drawRow = (cells, bold, fill) => {
      const h = heightOf(cells, bold);
      need(h);
      const top = y;
      let x = M;
      cells.forEach((cell, c) => {
        page.drawRectangle({ x, y: top - h, width: widths[c], height: h, borderColor: rgb(0.72, 0.74, 0.78), borderWidth: 0.6, ...(fill ? { color: fill } : {}) });
        let ty = top - pad;
        for (const ln of layout(cell, size, widths[c] - 2 * pad, bold)) {
          ty -= lh;
          drawLine(ln, x + pad, size, ty + 3);
        }
        x += widths[c];
      });
      y -= h;
    };
    y -= 2;
    drawRow(t.header, true, rgb(0.9, 0.93, 0.97));
    for (const row of t.rows) {
      const h = heightOf(row, false);
      if (y - h < BOTTOM) { newPage(); drawRow(t.header, true, rgb(0.9, 0.93, 0.97)); }
      drawRow(row, false);
    }
    y -= 10;
  }

  if (!page) newPage();
  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    const label = `Page ${idx + 1} of ${pages.length}`;
    p.drawText(label, { x: A4[0] / 2 - F.r.widthOfTextAtSize(label, 8) / 2, y: 28, size: 8, font: F.r, color: rgb(0.5, 0.5, 0.55) });
  });

  doc.setTitle(toWinAnsi(title || "EXILE AI document"));
  doc.setAuthor(toWinAnsi(author));
  doc.setProducer("EXILE AI");
  doc.setCreator("EXILE AI artifact engine");
  const bytes = await doc.save({ useObjectStreams: false });
  return { buffer: Buffer.from(bytes), metadata: { pages: pages.length, title } };
}

async function validatePdf(buffer, spec, ctx) {
  const result = await validatePdfStructure(buffer, ctx);
  const { checks, failures, skipped } = result;
  if (!failures.length && result.text && spec && spec.content !== undefined) {
    const flat = squash(result.text.text);
    const missing = expectedSnippets(parseMarkdown(cleanContent(spec.content)), toWinAnsi).filter((s) => !flat.includes(s));
    if (missing.length) failures.push("Expected document text was not found in the rendered PDF.");
    else checks.push("Rendered text matches the source content");
  }
  return { checks, failures, skipped };
}

// ===================================================================== DOCX

const MONO = "Consolas";

function docxRuns(runs, opts = {}) {
  return runs.map((r) => {
    const base = { text: r.text, bold: opts.bold || r.bold, italics: opts.italics || r.italic, font: r.code ? MONO : undefined, size: opts.size };
    if (r.href && isSafeUrl(r.href)) {
      return new ExternalHyperlink({ link: r.href, children: [new TextRun({ ...base, color: "0B4FB3", underline: {} })] });
    }
    return new TextRun(base);
  });
}

async function generateDocx(spec) {
  const { title, blocks, author } = prepareDocument(spec);
  const children = [];
  let orderedInstance = 0;
  const headingMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
  let tables = 0;
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })] }));
  let skipped = false;

  for (const b of blocks) {
    if (b.type === "heading") {
      if (!skipped && title && runsToText(b.runs) === title && !spec.title) { skipped = true; continue; }
      children.push(new Paragraph({ heading: headingMap[b.level] || HeadingLevel.HEADING_4, children: docxRuns(b.runs) }));
    } else if (b.type === "paragraph") {
      children.push(new Paragraph({ spacing: { after: 120 }, children: docxRuns(b.runs) }));
    } else if (b.type === "quote") {
      children.push(new Paragraph({
        indent: { left: 360 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: "B8C0CC", space: 8 } },
        children: docxRuns(b.runs, { italics: true }),
      }));
    } else if (b.type === "list") {
      orderedInstance += b.ordered ? 1 : 0;
      for (const item of b.items) {
        children.push(new Paragraph({
          children: docxRuns(item.runs),
          ...(b.ordered
            ? { numbering: { reference: "exile-ordered", level: item.level, instance: orderedInstance } }
            : { bullet: { level: item.level } }),
        }));
      }
    } else if (b.type === "code") {
      for (const line of b.text.split("\n")) {
        children.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: "F2F4F7", color: "auto" },
          spacing: { after: 0 },
          children: [new TextRun({ text: line.replace(/\t/g, "    "), font: MONO, size: 18 })],
        }));
      }
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (b.type === "hr") {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFC5CE", space: 1 } }, children: [] }));
    } else if (b.type === "table") {
      tables += 1;
      const cell = (runs, header) => new TableCell({
        width: { size: 100 / b.header.length, type: WidthType.PERCENTAGE },
        shading: header ? { type: ShadingType.CLEAR, fill: "E6EDF7", color: "auto" } : undefined,
        children: [new Paragraph({ children: docxRuns(runs, { bold: header }) })],
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: b.header.map((h) => cell(h, true)) }),
          ...b.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
        ],
      }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }

  const document = new Document({
    creator: author,
    title: title || "EXILE AI document",
    description: "Generated by EXILE AI",
    numbering: {
      config: [{
        reference: "exile-ordered",
        levels: [0, 1, 2].map((level) => ({
          level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  const buffer = await Packer.toBuffer(document);
  return { buffer, metadata: { tables, title } };
}

function stripXml(xml) {
  return xml.replace(/<w:tab\/>/g, " ").replace(/<\/w:p>/g, " ").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function validateOoxml(buffer, { required, mainPart, ext }, ctx) {
  const checks = [];
  const failures = [];
  const skipped = [];
  let files;
  try {
    files = readZipChecked(buffer);
    checks.push(`Office package opens and every entry passes its CRC-32 (${files.size} parts)`);
  } catch (error) {
    return { checks, failures: [`Office package is invalid: ${error.message}`], skipped, files: null };
  }
  for (const part of required) if (!files.has(part)) failures.push(`Required part missing: ${part}`);
  if (!failures.length) checks.push("Required package parts present");
  let badXml = 0;
  for (const [name, data] of files) {
    if (/\.(xml|rels)$/i.test(name)) {
      const problem = isWellFormedXml(utf8(data));
      if (problem) { badXml++; failures.push(`${name} is not well-formed XML: ${problem}`); }
    }
  }
  if (!badXml) checks.push("All XML parts are well-formed");
  return { checks, failures, skipped, files, mainXml: files.get(mainPart) ? utf8(files.get(mainPart)) : "" };
}

async function validateDocx(buffer, spec, ctx) {
  const base = await validateOoxml(buffer, {
    required: ["[Content_Types].xml", "_rels/.rels", "word/document.xml"], mainPart: "word/document.xml", ext: "docx",
  }, ctx);
  const { checks, failures, skipped } = base;
  if (failures.length) return { checks, failures, skipped };
  const flat = squash(stripXml(base.mainXml));
  if (!flat.length) failures.push("Document body is empty.");
  else {
    checks.push("Document body contains text");
    if (spec?.content !== undefined) {
      const missing = expectedSnippets(parseMarkdown(cleanContent(spec.content))).filter((s) => !flat.includes(s));
      if (missing.length) failures.push("Expected document text was not found in the Word document.");
      else checks.push("Document text matches the source content");
    }
  }
  const render = await renderToPdfWithOffice(buffer, "docx", ctx.tempDir);
  if (render.available) {
    if (render.pages < 1) failures.push("LibreOffice rendered zero pages.");
    else checks.push(`Renders in LibreOffice (${render.pages} page${render.pages === 1 ? "" : "s"})`);
  } else skipped.push(`layout rendering (${render.reason})`);
  return { checks, failures, skipped };
}

// ==================================================================== plain

async function generateTxt(spec) {
  const content = cleanContent(spec.content, { max: 2_000_000 });
  return { buffer: Buffer.from(`${content}\n`, "utf8"), metadata: { characters: content.length } };
}

async function generateMd(spec) {
  const content = cleanContent(spec.content, { max: 2_000_000 });
  const title = spec.title && !/^\s*#\s/.test(content) ? `# ${String(spec.title).slice(0, 200)}\n\n` : "";
  return { buffer: Buffer.from(`${title}${content}\n`, "utf8"), metadata: { characters: content.length } };
}

async function validateText(buffer, spec) {
  const checks = [];
  const failures = [];
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    checks.push("Valid UTF-8");
  } catch {
    return { checks, failures: ["File is not valid UTF-8."], skipped: [] };
  }
  if (!text.trim()) failures.push("File is empty.");
  else checks.push("File has content");
  if (text.includes("\u0000")) failures.push("File contains NUL bytes.");
  else checks.push("No binary content");
  if (spec?.content !== undefined && text.trim().length && !squash(text).includes(squash(cleanContent(spec.content, { max: 80 })).slice(0, 60))) {
    failures.push("File does not start with the requested content.");
  } else if (spec?.content !== undefined) checks.push("Content matches the request");
  return { checks, failures, skipped: [] };
}

// ===================================================================== HTML

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function htmlRuns(runs) {
  return runs.map((r) => {
    let out = esc(r.text);
    if (r.code) out = `<code>${out}</code>`;
    if (r.bold) out = `<strong>${out}</strong>`;
    if (r.italic) out = `<em>${out}</em>`;
    if (r.href && isSafeUrl(r.href)) out = `<a href="${esc(r.href)}" rel="noopener noreferrer">${out}</a>`;
    return out;
  }).join("");
}

export function renderHtmlBody(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "heading") out.push(`<h${b.level}>${htmlRuns(b.runs)}</h${b.level}>`);
    else if (b.type === "paragraph") out.push(`<p>${htmlRuns(b.runs)}</p>`);
    else if (b.type === "quote") out.push(`<blockquote>${htmlRuns(b.runs)}</blockquote>`);
    else if (b.type === "hr") out.push("<hr>");
    else if (b.type === "code") out.push(`<pre><code>${esc(b.text)}</code></pre>`);
    else if (b.type === "list") {
      const tag = b.ordered ? "ol" : "ul";
      out.push(`<${tag}>${b.items.map((i) => `<li${i.level ? ` style="margin-left:${i.level * 1.2}em"` : ""}>${htmlRuns(i.runs)}</li>`).join("")}</${tag}>`);
    } else if (b.type === "table") {
      out.push(`<table><thead><tr>${b.header.map((h) => `<th>${htmlRuns(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlRuns(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
  }
  return out.join("\n");
}

async function generateHtml(spec) {
  const { title, blocks } = prepareDocument(spec);
  const css = "body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1f24}h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .5em}table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #c9ced6;padding:.4em .6em;text-align:left}th{background:#eef2f8}pre{background:#f3f5f8;padding:.8em;overflow:auto;border-radius:6px}code{font-family:Consolas,Menlo,monospace}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #b8c0cc;color:#444}";
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>${esc(title || "EXILE AI document")}</title>`,
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    renderHtmlBody(blocks),
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { buffer: Buffer.from(html, "utf8"), metadata: { title } };
}

async function validateHtml(buffer, spec) {
  const checks = [];
  const failures = [];
  const html = buffer.toString("utf8");
  if (/^<!doctype html>/i.test(html)) checks.push("HTML5 doctype present"); else failures.push("Missing <!doctype html>.");
  if (/<script\b/i.test(html)) failures.push("HTML contains a <script> element."); else checks.push("No script elements");
  if (/\son[a-z]+\s*=/i.test(html.replace(/<style[\s\S]*?<\/style>/i, ""))) failures.push("HTML contains an inline event handler."); else checks.push("No inline event handlers");
  if (/javascript:/i.test(html)) failures.push("HTML contains a javascript: URL."); else checks.push("No javascript: URLs");
  for (const tag of ["table", "ul", "ol", "li", "p", "h1", "h2", "h3", "h4", "pre", "blockquote"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "gi")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (open !== close) failures.push(`Unbalanced <${tag}> tags (${open} open, ${close} closed).`);
  }
  if (!failures.some((f) => f.startsWith("Unbalanced"))) checks.push("Block tags are balanced");
  if (spec?.content !== undefined) {
    const text = squash(html.replace(/<style[\s\S]*?<\/style>/i, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    const missing = expectedSnippets(parseMarkdown(cleanContent(spec.content))).filter((s) => !text.includes(s));
    if (missing.length) failures.push("Expected text was not found in the HTML."); else checks.push("HTML text matches the source content");
  }
  return { checks, failures, skipped: [] };
}

// ====================================================================== RTF

function rtfEscape(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\line ";
    else if (ch === "\t") out += "\\tab ";
    else if (code < 32) continue;
    else if (code < 128) out += ch;
    else if (code <= 0xffff) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else {
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

function rtfRuns(runs) {
  return runs.map((r) => {
    let t = rtfEscape(r.text);
    if (r.code) t = `{\\f1 ${t}}`;
    if (r.bold) t = `{\\b ${t}}`;
    if (r.italic) t = `{\\i ${t}}`;
    return t;
  }).join("");
}

async function generateRtf(spec) {
  const { title, blocks } = prepareDocument(spec);
  const sizes = { 1: 40, 2: 32, 3: 26, 4: 23 };
  const out = ["{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1", "{\\fonttbl{\\f0\\fswiss Calibri;}{\\f1\\fmodern Consolas;}}", "\\viewkind4\\f0\\fs22"];
  if (title) out.push(`{\\pard\\sa200\\b\\fs48 ${rtfEscape(title)}\\par}`);
  let skipped = false;
  for (const b of blocks) {
    if (b.type === "heading") {
      if (!skipped && title && runsToText(b.runs) === title && !spec.title) { skipped = true; continue; }
      out.push(`{\\pard\\sb200\\sa100\\b\\fs${sizes[b.level] || 23} ${rtfRuns(b.runs)}\\par}`);
    } else if (b.type === "paragraph") out.push(`{\\pard\\sa120 ${rtfRuns(b.runs)}\\par}`);
    else if (b.type === "quote") out.push(`{\\pard\\li480\\sa120\\i ${rtfRuns(b.runs)}\\par}`);
    else if (b.type === "hr") out.push("{\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\par}");
    else if (b.type === "code") out.push(...b.text.split("\n").map((l) => `{\\pard\\f1\\fs18 ${rtfEscape(l)}\\par}`));
    else if (b.type === "list") {
      let n = 0;
      for (const it of b.items) {
        n++;
        out.push(`{\\pard\\li${360 + it.level * 360}\\fi-360\\sa40 ${b.ordered ? `${n}.` : "\\u8226?"}\\tab ${rtfRuns(it.runs)}\\par}`);
      }
    } else if (b.type === "table") {
      const cols = b.header.length;
      const width = 9000;
      const cellx = Array.from({ length: cols }, (_, c) => `\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx${Math.round(((c + 1) * width) / cols)}`).join("");
      const row = (cells, bold) => `\\trowd\\trgaph80${cellx}${cells.map((c) => `\\intbl ${bold ? "{\\b " : ""}${rtfRuns(c)}${bold ? "}" : ""}\\cell`).join("")}\\row`;
      out.push(row(b.header, true), ...b.rows.map((r) => row(r, false)), "\\pard\\par");
    }
  }
  out.push("}");
  return { buffer: Buffer.from(out.join("\n") + "\n", "ascii"), metadata: { title } };
}

function rtfPlain(rtf) {
  return rtf
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\\\\/g, "\u0001").replace(/\\\{/g, "\u0002").replace(/\\\}/g, "\u0003")
    .replace(/\{\\fonttbl[\s\S]*?\}\}/, "")
    .replace(/\\[a-z]+-?\d* ?/gi, " ")
    .replace(/[{}]/g, "")
    .replace(/\u0001/g, "\\").replace(/\u0002/g, "{").replace(/\u0003/g, "}");
}

async function validateRtf(buffer, spec, ctx) {
  const checks = [];
  const failures = [];
  const skipped = [];
  const text = buffer.toString("latin1");
  if (text.startsWith("{\\rtf1")) checks.push("RTF header present"); else failures.push("Missing {\\rtf1 header.");
  let depth = 0;
  let broken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) { broken = true; break; } }
  }
  if (broken || depth !== 0) failures.push("RTF braces are unbalanced."); else checks.push("RTF braces are balanced");
  if (!failures.length && spec?.content !== undefined) {
    const flat = squash(rtfPlain(text));
    const missing = expectedSnippets(parseMarkdown(cleanContent(spec.content))).filter((s) => !flat.includes(s));
    if (missing.length) failures.push("Expected text was not found in the RTF."); else checks.push("RTF text matches the source content");
  }
  if (!failures.length) {
    const render = await renderToPdfWithOffice(buffer, "rtf", ctx.tempDir);
    if (render.available) {
      if (render.pages < 1) failures.push("LibreOffice rendered zero pages.");
      else checks.push(`Renders in LibreOffice (${render.pages} page${render.pages === 1 ? "" : "s"})`);
    } else skipped.push(`layout rendering (${render.reason})`);
  }
  return { checks, failures, skipped };
}

export const documentGenerators = {
  pdf: { generate: generatePdf, validate: validatePdf },
  docx: { generate: generateDocx, validate: validateDocx },
  txt: { generate: generateTxt, validate: validateText },
  md: { generate: generateMd, validate: validateText },
  rtf: { generate: generateRtf, validate: validateRtf },
  html: { generate: generateHtml, validate: validateHtml },
};

export { validateOoxml, stripXml, squash, expectedSnippets, blocksToPlainText };
