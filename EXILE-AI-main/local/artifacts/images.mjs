/**
 * Local image engine: SVG (sanitized), procedural graphics, and sharp-based processing.
 * Nothing here calls a cloud service. AI image providers are an optional enhancement
 * handled by the engine's provider hook, never a requirement for basic images.
 */
import sharp from "sharp";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { invalid } from "./errors.mjs";

sharp.cache(false);
sharp.concurrency(1);

export const IMAGE_LIMITS = Object.freeze({ maxInputPixels: 40_000_000, maxOutputDimension: 8192, maxBatch: 20 });
const sharpOpts = { limitInputPixels: IMAGE_LIMITS.maxInputPixels, failOn: "error" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// -------------------------------------------------------------------- SVG safety

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "use", "symbol", "image", "filter",
  "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix", "feFlood", "feComposite", "feMerge", "feMergeNode", "feDropShadow",
]);

/** Reject anything in an SVG that can script, fetch, or embed other content. */
export function sanitizeSvg(input) {
  const svg = String(input ?? "").replace(/^﻿/, "").trim();
  if (!svg) throw invalid("The SVG is empty.");
  if (svg.length > 2_000_000) throw invalid("The SVG is larger than 2 MB.");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[(?=[\s\S]*?<script)/i.test(svg)) throw invalid("SVG DOCTYPE and ENTITY declarations are not allowed.");
  const valid = XMLValidator.validate(svg);
  if (valid !== true) throw invalid(`The SVG is not well-formed XML: ${valid.err.msg}`);
  if (/<\s*(script|foreignObject|iframe|object|embed|animate|set|style)\b/i.test(svg)) throw invalid("The SVG contains a disallowed element (script, foreignObject, style, animation or embed).");
  if (/\son[a-z]+\s*=/i.test(svg)) throw invalid("The SVG contains an event-handler attribute.");
  if (/javascript:|vbscript:/i.test(svg)) throw invalid("The SVG contains a script URL.");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", preserveOrder: true, processEntities: false });
  const tree = parser.parse(svg);
  let sawRoot = false;
  const walk = (nodes, depth) => {
    if (depth > 60) throw invalid("The SVG is nested too deeply.");
    for (const node of nodes) {
      for (const [tag, children] of Object.entries(node)) {
        if (tag === ":@" || tag === "#text" || tag === "?xml") continue;
        if (!ALLOWED_ELEMENTS.has(tag)) throw invalid(`The SVG element <${tag}> is not allowed.`);
        if (tag === "svg" && depth === 0) sawRoot = true;
        const attrs = node[":@"] || {};
        for (const [name, value] of Object.entries(attrs)) {
          const a = name.replace(/^@/, "").toLowerCase();
          if (a === "href" || a === "xlink:href") {
            const v = String(value).trim();
            if (!(v.startsWith("#") || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/i.test(v))) throw invalid("SVG references must be internal (#id) or embedded PNG/JPEG data.");
          }
          if (/url\(\s*['"]?(?!#)/i.test(String(value))) throw invalid("SVG url() references must point to an internal #id.");
        }
        if (Array.isArray(children)) walk(children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  if (!sawRoot) throw invalid("The document must have an <svg> root element.");
  return svg;
}

// ------------------------------------------------------------- procedural art

const hex = /^#[0-9a-fA-F]{6}$/;
const color = (c, fallback) => (typeof c === "string" && hex.test(c) ? c : fallback);

function dims(spec) {
  const w = Math.round(Number(spec.width) || 1024);
  const h = Math.round(Number(spec.height) || 1024);
  if (w < 16 || h < 16 || w > IMAGE_LIMITS.maxOutputDimension || h > IMAGE_LIMITS.maxOutputDimension) {
    throw invalid(`Image width and height must be between 16 and ${IMAGE_LIMITS.maxOutputDimension} pixels.`);
  }
  if (w * h > IMAGE_LIMITS.maxInputPixels) throw invalid("The requested image has too many pixels.");
  return { w, h };
}

function wrapText(text, maxChars) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if ((line + " " + word).trim().length > maxChars && line) { lines.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

/** Deterministic PRNG so a seed always yields the same picture. */
function rng(seed) {
  let s = (Number(seed) || 1) >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function proceduralSvg(spec) {
  const kind = String(spec.type || "gradient");
  const { w, h } = dims(spec);
  const c1 = color(spec.color1, "#0F2A52");
  const c2 = color(spec.color2, "#0B4FB3");
  const fg = color(spec.textColor, "#FFFFFF");
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  const grad = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`;
  const parts = [open, grad];

  if (kind === "gradient" || kind === "card") {
    parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
    if (kind === "card") {
      const title = String(spec.title || "").slice(0, 160);
      const subtitle = String(spec.subtitle || "").slice(0, 240);
      const size = Math.round(Math.min(w, h) / 10);
      const lines = wrapText(title, Math.max(8, Math.floor((w * 0.8) / (size * 0.55)))).slice(0, 5);
      let y = h / 2 - ((lines.length - 1) * size * 1.2) / 2;
      for (const ln of lines) { parts.push(`<text x="${w / 2}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${fg}" text-anchor="middle">${esc(ln)}</text>`); y += size * 1.2; }
      if (subtitle) parts.push(`<text x="${w / 2}" y="${y + size * 0.5}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(size * 0.4)}" fill="${fg}" fill-opacity="0.85" text-anchor="middle">${esc(subtitle)}</text>`);
    }
  } else if (kind === "abstract") {
    const rand = rng(spec.seed);
    parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
    const count = Math.min(90, Math.max(18, Number(spec.count) || 42));
    for (let i = 0; i < count; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 12 + rand() * Math.min(w, h) * 0.16;
      const opacity = (0.08 + rand() * 0.28).toFixed(2);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${i % 2 ? c1 : c2}" fill-opacity="${opacity}"/>`);
    }
    for (let i = 0; i < 12; i++) {
      const x1 = rand() * w, y1 = rand() * h;
      const x2 = rand() * w, y2 = rand() * h;
      parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${fg}" stroke-opacity="0.18" stroke-width="${1 + rand() * 3}"/>`);
    }
    if (spec.title) {
      const title = String(spec.title).slice(0, 100);
      parts.push(`<text x="${w * 0.08}" y="${h * 0.88}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(Math.min(w, h) / 14)}" font-weight="700" fill="${fg}">${esc(title)}</text>`);
    }
  } else if (kind === "logo") {
    const title = String(spec.title || "EXILE").trim().slice(0, 80);
    const words = title.split(/\s+/).filter(Boolean);
    const initials = words.slice(0, 2).map(x => x[0]).join("").toUpperCase() || "X";
    const cx = w / 2, cy = h * 0.43;
    const radius = Math.min(w, h) * 0.23;
    parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${fg}" stroke-width="${Math.max(4, radius * 0.055)}" stroke-opacity="0.9"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius * 0.78}" fill="none" stroke="${fg}" stroke-width="${Math.max(2, radius * 0.018)}" stroke-opacity="0.45"/>`);
    parts.push(`<path d="M ${cx} ${cy - radius * 0.58} L ${cx + radius * 0.5} ${cy + radius * 0.42} L ${cx - radius * 0.5} ${cy + radius * 0.42} Z" fill="${fg}" fill-opacity="0.16" stroke="${fg}" stroke-width="${Math.max(3, radius * 0.045)}" stroke-linejoin="round"/>`);
    parts.push(`<text x="${cx}" y="${cy + radius * 0.2}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(radius * 0.65)}" font-weight="700" fill="${fg}" text-anchor="middle">${esc(initials)}</text>`);
    parts.push(`<text x="${cx}" y="${h * 0.82}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.075)}" font-weight="700" letter-spacing="3" fill="${fg}" text-anchor="middle">${esc(title)}</text>`);
  } else if (kind === "icon") {
    const symbol = String(spec.symbol || "diamond").toLowerCase();
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) * 0.3;
    parts.push(`<rect width="${w}" height="${h}" rx="${Math.min(w, h) * 0.12}" fill="url(#bg)"/>`);
    if (symbol === "circle") {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-width="${Math.max(5, r * 0.13)}"/>`);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.42}" fill="${fg}"/>`);
    } else if (symbol === "bolt") {
      parts.push(`<path d="M ${cx + r * 0.1} ${cy - r} L ${cx - r * 0.65} ${cy + r * 0.08} L ${cx - r * 0.08} ${cy + r * 0.08} L ${cx - r * 0.25} ${cy + r} L ${cx + r * 0.7} ${cy - r * 0.2} L ${cx + r * 0.12} ${cy - r * 0.2} Z" fill="${fg}"/>`);
    } else {
      parts.push(`<path d="M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z" fill="${fg}" fill-opacity="0.92"/>`);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.3}" fill="${c1}"/>`);
    }
  } else if (kind === "diagram") {
    const labels = (Array.isArray(spec.labels) ? spec.labels : ["Start", "Process", "Result"])
      .slice(0, 6).map(x => String(x).slice(0, 32));
    if (labels.length < 2) throw invalid("A diagram needs at least two labels.");
    parts.push(`<rect width="${w}" height="${h}" fill="#F7F9FC"/>`);
    if (spec.title) parts.push(`<text x="${w / 2}" y="${h * 0.14}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.055)}" font-weight="700" fill="#172033" text-anchor="middle">${esc(String(spec.title).slice(0, 100))}</text>`);
    const gap = w * 0.035;
    const nodeW = Math.min(w * 0.25, (w * 0.82 - gap * (labels.length - 1)) / labels.length);
    const nodeH = h * 0.22;
    const total = labels.length * nodeW + (labels.length - 1) * gap;
    const startX = (w - total) / 2;
    const y = h * 0.42;
    labels.forEach((label, i) => {
      const x = startX + i * (nodeW + gap);
      if (i < labels.length - 1) {
        const x1 = x + nodeW, x2 = x1 + gap;
        const mid = y + nodeH / 2;
        parts.push(`<line x1="${x1}" y1="${mid}" x2="${x2 - 8}" y2="${mid}" stroke="#52627A" stroke-width="4"/>`);
        parts.push(`<path d="M ${x2 - 13} ${mid - 7} L ${x2 - 3} ${mid} L ${x2 - 13} ${mid + 7}" fill="none" stroke="#52627A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      parts.push(`<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="14" fill="${i % 2 ? c2 : c1}"/>`);
      const lines = wrapText(label, Math.max(8, Math.floor(nodeW / 13))).slice(0, 2);
      lines.forEach((line, j) => parts.push(`<text x="${x + nodeW / 2}" y="${y + nodeH / 2 + (j - (lines.length - 1) / 2) * 22 + 7}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.033)}" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc(line)}</text>`));
    });
  } else if (kind === "poster") {
    const title = String(spec.title || "YOUR TITLE").slice(0, 120);
    const subtitle = String(spec.subtitle || "").slice(0, 220);
    parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
    parts.push(`<circle cx="${w * 0.82}" cy="${h * 0.2}" r="${Math.min(w, h) * 0.19}" fill="${fg}" fill-opacity="0.08"/>`);
    parts.push(`<path d="M 0 ${h * 0.78} Q ${w * 0.5} ${h * 0.58} ${w} ${h * 0.8} L ${w} ${h} L 0 ${h} Z" fill="#000000" fill-opacity="0.14"/>`);
    const size = Math.round(Math.min(w, h) * 0.105);
    const lines = wrapText(title, Math.max(8, Math.floor(w * 0.78 / (size * 0.56)))).slice(0, 4);
    let y = h * 0.42 - (lines.length - 1) * size * 0.62;
    for (const line of lines) {
      parts.push(`<text x="${w * 0.1}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="800" fill="${fg}">${esc(line)}</text>`);
      y += size * 1.24;
    }
    if (subtitle) {
      const subLines = wrapText(subtitle, Math.max(12, Math.floor(w * 0.78 / (size * 0.34)))).slice(0, 3);
      subLines.forEach((line, i) => parts.push(`<text x="${w * 0.1}" y="${h * 0.72 + i * size * 0.42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(size * 0.32)}" fill="${fg}" fill-opacity="0.9">${esc(line)}</text>`));
    }
  } else if (kind === "pattern") {
    const rand = rng(spec.seed);
    parts.push(`<rect width="${w}" height="${h}" fill="${c1}"/>`);
    const count = Math.min(400, Math.max(10, Number(spec.count) || 80));
    for (let i = 0; i < count; i++) {
      const x = rand() * w, y = rand() * h, r = 8 + rand() * Math.min(w, h) * 0.08;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c2}" fill-opacity="${(0.15 + rand() * 0.5).toFixed(2)}"/>`);
    }
  } else if (kind === "bar-chart" || kind === "line-chart") {
    const data = Array.isArray(spec.data) ? spec.data : [];
    if (data.length < 2 || data.length > 60) {
      throw invalid("Charts require between 2 and 60 data rows.");
    }
    if (data.some((d) =>
      !d ||
      typeof d.label !== "string" ||
      !d.label.trim() ||
      d.label.trim().length > 80 ||
      typeof d.value !== "number" ||
      !Number.isFinite(d.value) ||
      Math.abs(d.value) > 1e9
    )) {
      throw invalid("Chart rows require labels of 1–80 characters and finite numeric values within ±1 billion.");
    }
    const values = data.map((d) => d.value);
    const max = Math.max(...values, 0) || 1;
    const min = Math.min(...values, 0);
    const pad = { l: 70, r: 30, t: 70, b: 70 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const yOf = (v) => pad.t + ph - ((v - min) / (max - min || 1)) * ph;
    parts.push(`<rect width="${w}" height="${h}" fill="#FFFFFF"/>`);
    if (spec.title) parts.push(`<text x="${w / 2}" y="40" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="700" fill="#1B1F24" text-anchor="middle">${esc(String(spec.title).slice(0, 120))}</text>`);
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const y = yOf(v);
      parts.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="#D9DEE6" stroke-width="1"/>`);
      parts.push(`<text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="#5B6573" text-anchor="end">${esc(Number.isInteger(v) ? v : v.toFixed(1))}</text>`);
    }
    const step = pw / data.length;
    const stroke = color(spec.color2, "#0B4FB3");
    if (kind === "bar-chart") {
      data.forEach((d, i) => {
        const x = pad.l + i * step + step * 0.15;
        const valueY = yOf(Number(d.value));
        const zeroY = yOf(0);
        parts.push(`<rect x="${x.toFixed(1)}" y="${Math.min(valueY, zeroY).toFixed(1)}" width="${(step * 0.7).toFixed(1)}" height="${Math.abs(zeroY - valueY).toFixed(1)}" fill="${stroke}"/>`);
        parts.push(`<text x="${(x + step * 0.35).toFixed(1)}" y="${h - pad.b + 24}" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="#1B1F24" text-anchor="middle">${esc(String(d.label ?? "").slice(0, 14))}</text>`);
      });
    } else {
      const pts = data.map((d, i) => `${(pad.l + i * step + step / 2).toFixed(1)},${yOf(Number(d.value)).toFixed(1)}`);
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linejoin="round"/>`);
      data.forEach((d, i) => {
        const x = pad.l + i * step + step / 2;
        parts.push(`<circle cx="${x.toFixed(1)}" cy="${yOf(Number(d.value)).toFixed(1)}" r="5" fill="${stroke}"/>`);
        parts.push(`<text x="${x.toFixed(1)}" y="${h - pad.b + 24}" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="#1B1F24" text-anchor="middle">${esc(String(d.label ?? "").slice(0, 14))}</text>`);
      });
    }
  } else {
    throw invalid(`Unknown procedural image type "${kind}". Use gradient, card, abstract, logo, icon, diagram, poster, pattern, bar-chart or line-chart.`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** The SVG source for a spec: user SVG (sanitized) or a procedural drawing. */
export function svgForSpec(spec) {
  if (typeof spec.svg === "string") return sanitizeSvg(spec.svg);
  if (spec.procedural && typeof spec.procedural === "object") return sanitizeSvg(proceduralSvg(spec.procedural));
  throw invalid("Provide `svg` or `procedural` to create an image.");
}

// ------------------------------------------------------------------ encoding

const OUT = {
  png: (s) => s.png({ compressionLevel: 9 }),
  jpg: (s, q) => s.flatten({ background: "#ffffff" }).jpeg({ quality: q, mozjpeg: true }),
  webp: (s, q) => s.webp({ quality: q }),
};

export async function encodeImage(pipeline, format, quality = 88) {
  const enc = OUT[format];
  if (!enc) throw invalid(`Cannot encode ${format}.`);
  const q = Math.max(1, Math.min(100, Math.round(Number(quality) || 88)));
  return enc(pipeline, q).toBuffer();
}

async function renderSvgTo(format, spec) {
  const svg = svgForSpec(spec);
  const pipeline = sharp(Buffer.from(svg), { ...sharpOpts, density: Math.max(72, Math.min(300, Number(spec.density) || 72)) });
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > IMAGE_LIMITS.maxInputPixels) throw invalid("The SVG renders to an unsupported size.");
  return encodeImage(pipeline, format, spec.quality);
}

async function generateSvgFile(spec) {
  const svg = svgForSpec(spec);
  return { buffer: Buffer.from(svg, "utf8"), metadata: { kind: "svg" } };
}

function rasterGenerator(format) {
  return async (spec) => {
    if (spec.source) throw invalid("Use the edit endpoint to process an existing image.");
    const buffer = await renderSvgTo(format, spec);
    const meta = await sharp(buffer, sharpOpts).metadata();
    return { buffer, metadata: { width: meta.width, height: meta.height, source: spec.svg ? "svg" : `procedural:${spec.procedural?.type}` } };
  };
}

// ----------------------------------------------------------------- processing

function clampInt(v, min, max, name) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

async function removeBackground(buffer, { tolerance = 40, color: key } = {}) {
  const tol = clampInt(tolerance, 0, 255, "tolerance");
  const img = sharp(buffer, sharpOpts).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const px = (x, y) => (y * W + x) * 4;
  let kr, kg, kb;
  if (key && hex.test(key)) { kr = parseInt(key.slice(1, 3), 16); kg = parseInt(key.slice(3, 5), 16); kb = parseInt(key.slice(5, 7), 16); }
  else { [kr, kg, kb] = [data[0], data[1], data[2]]; } // top-left pixel
  const near = (i) => Math.abs(data[i] - kr) + Math.abs(data[i + 1] - kg) + Math.abs(data[i + 2] - kb) <= tol * 3 / 2;
  const seen = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const k = y * W + x; if (seen[k]) return; seen[k] = 1; if (near(px(x, y))) stack.push(k); };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  let cleared = 0;
  while (stack.length) {
    const k = stack.pop();
    const x = k % W, y = (k / W) | 0;
    data[px(x, y) + 3] = 0;
    cleared++;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  if (cleared === 0) throw invalid("No uniform background connected to the image edges was found. Local background removal only works on solid-colour backgrounds; use a provider-based tool for complex scenes.");
  return { buffer: await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), cleared, total: W * H };
}

function watermarkSvg(w, h, { text, position = "bottom-right", opacity = 0.5, color: c = "#FFFFFF" }) {
  const t = String(text || "").slice(0, 80);
  if (!t) throw invalid("A watermark needs text.");
  const size = Math.max(14, Math.round(Math.min(w, h) / 20));
  const pad = Math.round(size * 0.8);
  const op = Math.max(0.05, Math.min(1, Number(opacity) || 0.5));
  const pos = {
    "bottom-right": { x: w - pad, y: h - pad, a: "end" }, "bottom-left": { x: pad, y: h - pad, a: "start" },
    "top-right": { x: w - pad, y: pad + size, a: "end" }, "top-left": { x: pad, y: pad + size, a: "start" },
    center: { x: w / 2, y: h / 2, a: "middle" },
  }[position];
  if (!pos) throw invalid("Unknown watermark position.");
  const fill = color(c, "#FFFFFF");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${pos.x}" y="${pos.y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${fill}" fill-opacity="${op}" stroke="#000000" stroke-opacity="${op / 2}" stroke-width="1" text-anchor="${pos.a}">${esc(t)}</text></svg>`);
}

/**
 * Apply an ordered list of operations to an image buffer.
 * Supported: resize, crop, rotate, flip, flop, grayscale, enhance, blur, watermark,
 * composite, removeBackground, convert (the output format is the `format` argument).
 */
export async function processImage(buffer, ops, format, { quality } = {}) {
  if (!Array.isArray(ops)) throw invalid("`operations` must be an array.");
  if (ops.length > 20) throw invalid("At most 20 operations are supported per edit.");
  let current = buffer;
  const applied = [];
  for (const raw of ops) {
    const op = raw?.op;
    const pipe = sharp(current, sharpOpts);
    if (op === "resize") {
      const width = raw.width === undefined ? undefined : clampInt(raw.width, 1, IMAGE_LIMITS.maxOutputDimension, "width");
      const height = raw.height === undefined ? undefined : clampInt(raw.height, 1, IMAGE_LIMITS.maxOutputDimension, "height");
      if (!width && !height) throw invalid("resize needs width and/or height.");
      const fit = ["cover", "contain", "fill", "inside", "outside"].includes(raw.fit) ? raw.fit : "inside";
      current = await pipe.resize({ width, height, fit, withoutEnlargement: raw.allowUpscale !== true, background: "#ffffff" }).png().toBuffer();
    } else if (op === "crop") {
      const meta = await pipe.metadata();
      const left = clampInt(raw.left, 0, meta.width - 1, "left");
      const top = clampInt(raw.top, 0, meta.height - 1, "top");
      const width = clampInt(raw.width, 1, meta.width - left, "width");
      const height = clampInt(raw.height, 1, meta.height - top, "height");
      current = await pipe.extract({ left, top, width, height }).png().toBuffer();
    } else if (op === "rotate") {
      current = await pipe.rotate(clampInt(raw.degrees, -360, 360, "degrees"), { background: "#00000000" }).png().toBuffer();
    } else if (op === "flip") current = await pipe.flip().png().toBuffer();
    else if (op === "flop") current = await pipe.flop().png().toBuffer();
    else if (op === "grayscale") current = await pipe.grayscale().png().toBuffer();
    else if (op === "blur") current = await pipe.blur(Math.max(0.3, Math.min(50, Number(raw.sigma) || 2))).png().toBuffer();
    else if (op === "enhance") {
      let p = pipe;
      if (raw.normalize !== false) p = p.normalise();
      const brightness = raw.brightness === undefined ? 1 : Math.max(0.2, Math.min(3, Number(raw.brightness)));
      const saturation = raw.saturation === undefined ? 1.1 : Math.max(0, Math.min(3, Number(raw.saturation)));
      p = p.modulate({ brightness, saturation });
      if (raw.sharpen !== false) p = p.sharpen({ sigma: 1 });
      current = await p.png().toBuffer();
    } else if (op === "watermark") {
      const meta = await pipe.metadata();
      current = await pipe.composite([{ input: watermarkSvg(meta.width, meta.height, raw), top: 0, left: 0 }]).png().toBuffer();
    } else if (op === "composite") {
      if (!raw.overlay || !Buffer.isBuffer(raw.overlay)) throw invalid("composite needs an overlay image.");
      const base = await pipe.metadata();
      const overlayMeta = await sharp(raw.overlay, sharpOpts).metadata();
      const left = clampInt(raw.left ?? 0, 0, Math.max(0, base.width - 1), "left");
      const top = clampInt(raw.top ?? 0, 0, Math.max(0, base.height - 1), "top");
      let overlay = raw.overlay;
      if (overlayMeta.width + left > base.width || overlayMeta.height + top > base.height) {
        overlay = await sharp(raw.overlay, sharpOpts).resize({ width: base.width - left, height: base.height - top, fit: "inside" }).png().toBuffer();
      }
      current = await pipe.composite([{ input: overlay, left, top, blend: "over" }]).png().toBuffer();
    } else if (op === "removeBackground") {
      current = (await removeBackground(current, raw)).buffer;
    } else if (op === "convert") {
      // No-op here: conversion happens at final encoding.
    } else {
      throw invalid(`Unknown image operation "${String(op).slice(0, 30)}".`);
    }
    applied.push(op);
  }
  const final = sharp(current, sharpOpts);
  const out = await encodeImage(final, format, quality);
  return { buffer: out, applied };
}

/** Generate N deterministic variations of a procedural spec by changing seed and colours. */
export function variationSpecs(base, count) {
  const n = Math.max(1, Math.min(8, Math.round(Number(count) || 3)));
  const palette = [["#0F2A52", "#0B4FB3"], ["#2B1B4E", "#7A3FB3"], ["#0E3B2E", "#1F9D6B"], ["#4A1F1F", "#D1593B"], ["#1F2933", "#52606D"], ["#3B2A0E", "#C8892B"], ["#103B4A", "#2B9DB3"], ["#3A1030", "#B3477A"]];
  return Array.from({ length: n }, (_, i) => ({ ...base, seed: (Number(base.seed) || 1) + i * 7919, color1: palette[(i + 1) % palette.length][0], color2: palette[(i + 1) % palette.length][1] }));
}

// ----------------------------------------------------------------- validation

async function validateRaster(buffer, spec, format) {
  const checks = [];
  const failures = [];
  let meta;
  try {
    meta = await sharp(buffer, sharpOpts).metadata();
  } catch (error) {
    return { checks, failures: [`Image does not decode: ${error.message}`], skipped: [] };
  }
  const want = format === "jpg" ? "jpeg" : format;
  if (meta.format !== want) failures.push(`Image decodes as ${meta.format}, expected ${want}.`);
  else checks.push(`Decodes as ${meta.format}`);
  if (!meta.width || !meta.height) failures.push("Image has no dimensions.");
  else checks.push(`Dimensions ${meta.width}x${meta.height}`);
  try {
    await sharp(buffer, sharpOpts).raw().toBuffer(); // full decode: catches truncated data
    checks.push("All pixel data decodes");
  } catch (error) {
    failures.push(`Pixel data is damaged: ${error.message}`);
  }
  if (!failures.length) {
    const stats = await sharp(buffer, sharpOpts).stats();
    const spread = Math.max(...stats.channels.map((c) => c.stdev));
    const hasAlpha = meta.hasAlpha && stats.channels[3] && stats.channels[3].min < 255;
    if (spread < 0.5 && !hasAlpha && spec?.allowBlank !== true) failures.push("Image is a single flat colour (blank).");
    else checks.push("Image has visible content");
    if (spec?.procedural?.width && meta.width !== Math.round(Number(spec.procedural.width))) failures.push("Image width does not match the request.");
    else if (spec?.procedural?.width) checks.push("Requested width matches");
  }
  return { checks, failures, skipped: [] };
}

async function validateSvgFile(buffer) {
  const checks = [];
  const failures = [];
  const text = buffer.toString("utf8");
  try {
    sanitizeSvg(text);
    checks.push("SVG is well-formed and passes the safety check");
  } catch (error) {
    return { checks, failures: [error.message], skipped: [] };
  }
  try {
    const meta = await sharp(buffer, sharpOpts).metadata();
    const png = await sharp(buffer, sharpOpts).png().toBuffer();
    const stats = await sharp(png, sharpOpts).stats();
    checks.push(`Renders (${meta.width}x${meta.height})`);
    if (Math.max(...stats.channels.map((c) => c.stdev)) < 0.5 && !(meta.hasAlpha && stats.channels[3]?.min < 255)) failures.push("SVG renders as a blank image.");
    else checks.push("Rendered image has visible content");
  } catch (error) {
    failures.push(`SVG does not render: ${error.message}`);
  }
  return { checks, failures, skipped: [] };
}

export const imageGenerators = {
  svg: { generate: generateSvgFile, validate: (b) => validateSvgFile(b) },
  png: { generate: rasterGenerator("png"), validate: (b, s) => validateRaster(b, s, "png") },
  jpg: { generate: rasterGenerator("jpg"), validate: (b, s) => validateRaster(b, s, "jpg") },
  webp: { generate: rasterGenerator("webp"), validate: (b, s) => validateRaster(b, s, "webp") },
};
export { validateRaster };
