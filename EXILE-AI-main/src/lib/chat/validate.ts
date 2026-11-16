/**
 * Content checks for attachments. The browser's `file.type` and the extension come from the user's OS and
 * can be wrong or spoofed (a renamed executable, a text file called .png). These helpers look at the actual
 * leading bytes so a file is only treated as an image/PDF/text if it really is one.
 */

export type DetectedKind = "png" | "jpeg" | "webp" | "gif" | "pdf" | "text" | "binary" | "empty";

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

export function sniffKind(head: Uint8Array): DetectedKind {
  if (head.length === 0) return "empty";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  // Text: no NUL bytes, no other control characters except tab/LF/FF/CR/ESC-free, and valid-looking UTF-8 / UTF-16 BOM.
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return "text"; // UTF-16 BOM
  for (const byte of head) {
    if (byte === 0) return "binary";
    if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) return "binary";
  }
  return "text";
}

export interface AttachmentCheck {
  name: string;
  /** Kind the app intends to treat the file as, from its declared type/extension. */
  expected: "image" | "pdf" | "text";
  /** First bytes of the file (at least 16, up to a few KB). */
  head: Uint8Array;
  size: number;
}

export type AttachmentVerdict = { ok: true; detected: DetectedKind } | { ok: false; error: string };

const IMAGE_KINDS = new Set<DetectedKind>(["png", "jpeg", "webp"]);

export function validateAttachment({ name, expected, head, size }: AttachmentCheck): AttachmentVerdict {
  if (size === 0) return { ok: false, error: `${name} is empty.` };
  const detected = sniffKind(head);
  if (expected === "image") {
    if (!IMAGE_KINDS.has(detected)) return { ok: false, error: `${name} is not a real PNG, JPEG or WebP image (its contents do not match its type).` };
  } else if (expected === "pdf") {
    if (detected !== "pdf") return { ok: false, error: `${name} is not a valid PDF (its contents do not match its type).` };
  } else if (detected !== "text") {
    return { ok: false, error: `${name} does not look like a text file (it contains binary data).` };
  }
  return { ok: true, detected };
}
