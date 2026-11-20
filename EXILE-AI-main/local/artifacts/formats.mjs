/**
 * Format registry for the artifact engine.
 *
 * A format is listed here only when a generator (or importer), a validator and a
 * delivery path exist for it. `whatsapp` is the attachment kind understood by the
 * existing WhatsApp sender (local/whatsapp.mjs), or null when that sender cannot
 * carry the type. `preview` says how the UI may show it.
 */

export const MB = 1024 * 1024;

export const FORMATS = Object.freeze({
  // Documents
  pdf:  { ext: "pdf",  mime: "application/pdf", kind: "document", label: "PDF", whatsapp: "document", preview: "pdf", maxBytes: 25 * MB },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", label: "Word document", whatsapp: "document", preview: "text", maxBytes: 25 * MB },
  txt:  { ext: "txt",  mime: "text/plain", kind: "document", label: "text file", whatsapp: "document", preview: "text", maxBytes: 10 * MB },
  md:   { ext: "md",   mime: "text/markdown", kind: "document", label: "Markdown file", whatsapp: null, preview: "text", maxBytes: 10 * MB },
  rtf:  { ext: "rtf",  mime: "application/rtf", kind: "document", label: "RTF document", whatsapp: null, preview: "text", maxBytes: 10 * MB },
  html: { ext: "html", mime: "text/html", kind: "document", label: "HTML page", whatsapp: null, preview: "html", maxBytes: 10 * MB },
  // Spreadsheets and data
  xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "data", label: "Excel workbook", whatsapp: "document", preview: "table", maxBytes: 25 * MB },
  csv:  { ext: "csv",  mime: "text/csv", kind: "data", label: "CSV file", whatsapp: "document", preview: "table", maxBytes: 25 * MB },
  json: { ext: "json", mime: "application/json", kind: "data", label: "JSON file", whatsapp: null, preview: "text", maxBytes: 25 * MB },
  xml:  { ext: "xml",  mime: "application/xml", kind: "data", label: "XML file", whatsapp: null, preview: "text", maxBytes: 25 * MB },
  // Presentations
  pptx: { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation", label: "PowerPoint presentation", whatsapp: "document", preview: "slides", maxBytes: 50 * MB },
  // Archives and projects
  zip:  { ext: "zip",  mime: "application/zip", kind: "archive", label: "ZIP archive", whatsapp: null, preview: "archive", maxBytes: 100 * MB },
  // Images
  png:  { ext: "png",  mime: "image/png", kind: "image", label: "PNG image", whatsapp: "image", preview: "image", maxBytes: 25 * MB },
  jpg:  { ext: "jpg",  mime: "image/jpeg", kind: "image", label: "JPEG image", whatsapp: "image", preview: "image", maxBytes: 25 * MB },
  webp: { ext: "webp", mime: "image/webp", kind: "image", label: "WebP image", whatsapp: "image", preview: "image", maxBytes: 25 * MB },
  svg:  { ext: "svg",  mime: "image/svg+xml", kind: "image", label: "SVG image", whatsapp: null, preview: "image", maxBytes: 5 * MB },
  // Audio
  wav:  { ext: "wav",  mime: "audio/wav", kind: "audio", label: "WAV audio", whatsapp: "audio", preview: "audio", maxBytes: 50 * MB },
  mp3:  { ext: "mp3",  mime: "audio/mpeg", kind: "audio", label: "MP3 audio", whatsapp: "audio", preview: "audio", maxBytes: 50 * MB },
  ogg:  { ext: "ogg",  mime: "audio/ogg", kind: "audio", label: "Ogg Opus audio", whatsapp: "audio", preview: "audio", maxBytes: 50 * MB },
  m4a:  { ext: "m4a",  mime: "audio/mp4", kind: "audio", label: "M4A audio", whatsapp: "audio", preview: "audio", maxBytes: 50 * MB },
  // Video (the existing WhatsApp sender does not carry video, so whatsapp is null)
  mp4:  { ext: "mp4",  mime: "video/mp4", kind: "video", label: "MP4 video", whatsapp: null, preview: "video", maxBytes: 200 * MB },
  webm: { ext: "webm", mime: "video/webm", kind: "video", label: "WebM video", whatsapp: null, preview: "video", maxBytes: 200 * MB },
});

/** Formats that can be served inline in the UI as images (SVG is sanitized at creation). */
export const INLINE_SAFE_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/svg+xml",
  "application/pdf", "audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4",
  "video/mp4", "video/webm",
]);

export const WHATSAPP_MAX_BYTES = 15 * MB;

export function getFormat(ext) {
  const key = String(ext || "").toLowerCase().replace(/^\./, "");
  const normalized = key === "jpeg" ? "jpg" : key;
  return Object.hasOwn(FORMATS, normalized) ? { id: normalized, ...FORMATS[normalized] } : null;
}

export function requireFormat(ext) {
  const format = getFormat(ext);
  if (!format) {
    const err = new Error(`Unsupported format "${String(ext).slice(0, 20)}". Supported: ${Object.keys(FORMATS).join(", ")}.`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  return format;
}

export function formatByMime(mime) {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  for (const [id, f] of Object.entries(FORMATS)) {
    if (f.mime === m) return { id, ...f };
  }
  return null;
}

/** Magic-number sniffing used when importing user-supplied files. Never trusts the extension. */
export function sniffFormat(buffer) {
  const b = buffer;
  if (!b || b.length < 4) return null;
  const startsWith = (s, off = 0) => b.length >= off + s.length && b.subarray(off, off + s.length).toString("latin1") === s;
  if (startsWith("%PDF-")) return "pdf";
  if (b[0] === 0x89 && startsWith("PNG", 1)) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (startsWith("RIFF") && startsWith("WEBP", 8)) return "webp";
  if (startsWith("RIFF") && startsWith("WAVE", 8)) return "wav";
  if (startsWith("OggS")) return "ogg";
  if (startsWith("ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  if (startsWith("ftyp", 4)) {
    const brand = b.subarray(8, 12).toString("latin1");
    return brand.startsWith("M4A") ? "m4a" : "mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5)) return "zip"; // docx/xlsx/pptx refined by the caller
  const head = b.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}
