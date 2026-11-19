import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

const TYPES = {
  pdf: {
    extension: "pdf",
    mime: "application/pdf",
    label: "PDF",
  },
  docx: {
    extension: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word document",
  },
  txt: {
    extension: "txt",
    mime: "text/plain",
    label: "text file",
  },
  csv: {
    extension: "csv",
    mime: "text/csv",
    label: "CSV file",
  },
};

export function detectWhatsAppFileRequest(input) {
  const text = String(input || "").trim();

  if (!text || text.length > 4000) return null;

  const asksToCreate =
    /\b(create|generate|make|prepare|write|build|export|produce|draft|attach)\b/i.test(text) ||
    /\bsend\s+(?:me\s+)?(?:a|an|the)\b/i.test(text);

  if (!asksToCreate) return null;

  if (/\b(?:xlsx|excel workbook|powerpoint|pptx|\.ppt)\b/i.test(text)) {
    return {
      unsupported: true,
      message: "I can currently generate PDF, Word (.docx), text (.txt), and CSV (.csv) attachments. Excel workbooks and PowerPoint files are not supported yet.",
    };
  }

  let type = "pdf";

  if (/\b(?:csv|\.csv)\b/i.test(text)) {
    type = "csv";
  } else if (/\b(?:docx|word document|word file|word format)\b/i.test(text)) {
    type = "docx";
  } else if (/\b(?:plain text|text file|\.txt)\b/i.test(text)) {
    type = "txt";
  }

  const explicitlyRequestsFile =
    /\b(?:pdf|docx|word document|word file|text file|plain text|csv|spreadsheet|document|file|report|resume|résumé|cv|invoice|letter|\.txt|\.pdf|\.csv)\b/i.test(text);

  if (!explicitlyRequestsFile) return null;

  return { type, ...TYPES[type] };
}

function cleanContent(content) {
  let text = String(content || "").trim();

  text = text
    .replace(/^```(?:markdown|md|text|csv|txt)?\s*\n/i, "")
    .replace(/\n```\s*$/, "")
    .slice(0, 16000);

  if (!text.trim()) {
    throw new Error("The AI returned empty document content.");
  }

  return text;
}

function safeFilename(type) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `exile-document-${stamp}.${TYPES[type].extension}`;
}

function toAscii(input) {
  return String(input)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function pdfEscape(input) {
  return toAscii(input)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapPdfText(text, width = 88) {
  const result = [];

  for (const original of text.split(/\r?\n/)) {
    const line = toAscii(original);
    if (!line.trim()) {
      result.push("");
      continue;
    }

    let remaining = line;

    while (remaining.length > width) {
      let cut = remaining.lastIndexOf(" ", width);
      if (cut < 1) cut = width;
      result.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }

    result.push(remaining);
  }

  return result.length ? result : [""];
}

function createPdf(text) {
  const lines = wrapPdfText(text);
  const pages = [];

  for (let i = 0; i < lines.length; i += 50) {
    pages.push(lines.slice(i, i + 50));
  }

  const objects = [];
  const addObject = (value) => {
    objects.push(value);
    return objects.length;
  };

  addObject("<< /Type /Catalog /Pages 2 0 R >>");
  addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const pageIds = [];

  for (const pageLines of pages) {
    const commands = [
      "BT",
      "/F1 10 Tf",
      "50 790 Td",
      "14 TL",
      ...pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      "ET",
    ].join("\n");

    const contentId = addObject(
      `<< /Length ${Buffer.byteLength(commands, "ascii")} >>\nstream\n${commands}\nendstream`
    );

    const pageId = objects.length + 1;
    pageIds.push(pageId);

    addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
  }

  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";

  for (let i = 1; i < offsets.length; i++) {
    output += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(output, "ascii");
}

async function createDocx(text) {
  const children = text.split(/\r?\n/).map((line) => {
    const value = line.trim();

    if (/^###\s+/.test(value)) {
      return new Paragraph({
        text: value.replace(/^###\s+/, ""),
        heading: HeadingLevel.HEADING_3,
      });
    }

    if (/^##\s+/.test(value)) {
      return new Paragraph({
        text: value.replace(/^##\s+/, ""),
        heading: HeadingLevel.HEADING_2,
      });
    }

    if (/^#\s+/.test(value)) {
      return new Paragraph({
        text: value.replace(/^#\s+/, ""),
        heading: HeadingLevel.HEADING_1,
      });
    }

    if (/^[-*]\s+/.test(value)) {
      return new Paragraph({
        text: value.replace(/^[-*]\s+/, ""),
        bullet: { indent: 360 },
      });
    }

    return new Paragraph({
      children: [new TextRun(value)],
    });
  });

  const document = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(document);
}

export async function createWhatsAppFile(type, rawContent) {
  if (!Object.hasOwn(TYPES, type)) {
    throw new Error("Unsupported document type.");
  }

  const content = cleanContent(rawContent);
  let buffer;

  if (type === "pdf") {
    buffer = createPdf(content);
  } else if (type === "docx") {
    buffer = await createDocx(content);
  } else {
    buffer = Buffer.from(content + "\n", "utf8");
  }

  if (!buffer?.length || buffer.length > 10 * 1024 * 1024) {
    throw new Error("The generated file is empty or exceeds the 10 MB generation limit.");
  }

  if (type === "pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("PDF validation failed.");
  }

  if (type === "docx" && !buffer.subarray(0, 2).equals(Buffer.from("PK"))) {
    throw new Error("Word document validation failed.");
  }

  const filename = safeFilename(type);

  return {
    filename,
    mimeType: TYPES[type].mime,
    dataUrl: `data:${TYPES[type].mime};base64,${buffer.toString("base64")}`,
  };
}

// ---------------------------------------------------------------------------
// Artifact-engine path (extends the workflow above; createWhatsAppFile and
// detectWhatsAppFileRequest are kept unchanged for compatibility).
// ---------------------------------------------------------------------------
import { detectArtifactRequest } from "./artifacts/request.mjs";
import { FORMATS, WHATSAPP_MAX_BYTES } from "./artifacts/formats.mjs";

const SENDABLE = Object.values(FORMATS)
  .filter((format) => format.whatsapp)
  .map((format) => format.label)
  .join(", ");

/** Message for the chat when generation failed. Distinguishes provider failure from file failure. */
function failureMessage(result) {
  if (result.code === "PROVIDER_FAILURE") {
    return "I couldn't get any content written right now because no permitted AI provider answered. Please try again shortly.";
  }
  if (result.code === "ENGINE_UNAVAILABLE") return `I can't make that file on this computer right now: ${result.error}`;
  if (result.code === "INVALID_INPUT") return `I couldn't build that file: ${result.error}`;
  return `I wrote the content but couldn't produce a valid file, so I did not send anything. (${String(result.error).slice(0, 200)})`;
}

/**
 * Handle a WhatsApp message that may ask for a file.
 * Returns null (not a file request), or { reply } where reply is plain text or
 * { text, attachment } ready for the conversation sender. The attachment carries
 * onQueued/onSent/onFailed hooks so the artifact's delivery state is only ever
 * "sent" after WhatsApp itself confirmed the send.
 * Throws an Error with `.userMessage` when generation fails.
 */
export async function createWhatsAppArtifact({ engine, text, jid, provider }) {
  const request = detectArtifactRequest(text);
  if (!request) return null;
  if (request.unsupported) return { reply: request.message };

  const eligibility = engine.whatsappEligibility(request.format);
  if (!eligibility.ok) {
    return { reply: `${eligibility.reason} I can send ${SENDABLE} here. You can also open EXILE's Artifacts page to create it and download it.` };
  }

  const result = await engine.create({ prompt: String(text), format: request.format, provider });
  if (!result.success) {
    const error = new Error(result.error || "Artifact generation failed.");
    error.code = result.code;
    error.userMessage = failureMessage(result);
    throw error;
  }

  if (result.sizeBytes > WHATSAPP_MAX_BYTES) {
    return { reply: `I created "${result.name}" (${(result.sizeBytes / 1048576).toFixed(1)} MB), but WhatsApp attachments are limited to 15 MB, so I haven't sent it. It is saved in EXILE's Artifacts.` };
  }

  const { buffer, meta } = await engine.read(result.artifactId);
  let delivery = null;
  return {
    reply: {
      text: `I've created your ${request.label}.`,
      attachment: {
        dataUrl: `data:${meta.mime};base64,${buffer.toString("base64")}`,
        filename: meta.name,
        caption: `Here is your ${request.label}, generated by Exile.`,
        artifactId: result.artifactId,
        onQueued: async () => { delivery = await engine.beginDelivery(result.artifactId, { channel: "whatsapp", to: jid }); },
        onSent: async () => { if (delivery) await engine.finishDelivery(result.artifactId, delivery.id, { sent: true }); },
        onFailed: async (message) => { if (delivery) await engine.finishDelivery(result.artifactId, delivery.id, { sent: false, error: message }); },
      },
    },
  };
}

export { detectArtifactRequest };
