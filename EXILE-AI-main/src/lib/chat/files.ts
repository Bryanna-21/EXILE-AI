/** Pure helpers for files, documents and attachments shown in chat. No DOM access. */

export type FileKind = "image" | "pdf" | "text" | "code" | "data" | "document" | "archive" | "audio" | "video" | "other";

const CODE_EXT = new Set(["js", "jsx", "ts", "tsx", "py", "html", "css", "sql", "java", "c", "h", "cpp", "hpp", "rs", "go", "sh", "php", "rb", "kt", "swift", "cs", "ps1", "toml"]);
const TEXT_EXT = new Set(["txt", "md", "markdown", "log", "rtf"]);
const DATA_EXT = new Set(["csv", "tsv", "json", "xml", "yaml", "yml"]);
const DOC_EXT = new Set(["doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "7z", "rar"]);

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

export function classifyFile(name: string, mime = ""): FileKind {
  const ext = fileExtension(name);
  const m = mime.toLowerCase();
  if (m.startsWith("image/") || /^(png|jpe?g|webp|gif|svg|bmp|avif)$/.test(ext)) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("audio/") || /^(mp3|wav|m4a|ogg|flac)$/.test(ext)) return "audio";
  if (m.startsWith("video/") || /^(mp4|webm|mov|mkv)$/.test(ext)) return "video";
  if (CODE_EXT.has(ext)) return "code";
  if (DATA_EXT.has(ext) || m === "application/json" || m === "text/csv") return "data";
  if (DOC_EXT.has(ext)) return "document";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (TEXT_EXT.has(ext) || m.startsWith("text/")) return "text";
  return "other";
}

/** Kinds whose contents can be shown as text in a preview and copied. */
export function isTextual(kind: FileKind): boolean {
  return kind === "text" || kind === "code" || kind === "data";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A file name that is safe to hand to a download: no paths, control or reserved characters. */
export function safeFilename(name: string, fallback = "download"): string {
  const base = Array.from(name.split(/[\\/]/).pop() ?? "")
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/[<>:"|?*]/g, "")
    .replace(/^[.\s]+|[\s.]+$/g, "")
    .slice(0, 120);
  return base || fallback;
}

/** Approximate decoded size of a base64 data URL, in bytes. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
}

export function dataUrlMime(dataUrl: string): string {
  return /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? "application/octet-stream";
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function extensionForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? "bin";
}

/* The Console stores "[Attached files: a.pdf, b.png]" at the end of a sent message's text. */
const LABEL = /\n\n\[Attached files: ([^\]]*)\]\s*$/;

export function stripAttachmentLabel(text: string): { text: string; names: string[] } {
  const m = LABEL.exec(text);
  if (!m) return { text, names: [] };
  return { text: text.slice(0, m.index), names: m[1].split(", ").map((n) => n.trim()).filter(Boolean) };
}

export function withAttachmentLabel(text: string, names: string[]): string {
  return names.length ? `${text}\n\n[Attached files: ${names.join(", ")}]` : text;
}
