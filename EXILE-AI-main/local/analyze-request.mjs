/**
 * Builds chat messages for POST /exile-analyze on the local server.
 *
 * The hosted function accepts { prompt, attachments }; the local server used to
 * read only body.messages, so a Document Intelligence request reached the model
 * as the system prompt alone (the prompt and every file were silently dropped).
 * This converts the same request shape into real multimodal messages and refuses
 * anything it cannot honestly pass on, instead of ignoring it.
 */

const SYSTEM =
  "You are EXILE's Document Understanding module. Extract structure, key facts, action items, and cite sections. Be concise and organized. " +
  "Only describe content that is actually present in the supplied material; if something could not be read, say so.";

export const LIMITS = Object.freeze({
  maxAttachments: 8,
  maxTextChars: 60000,
  maxImageDataUrlChars: 12 * 1024 * 1024,
  maxPromptChars: 8000,
});

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|csv))/i;

export class AnalyzeRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnalyzeRequestError";
    this.statusCode = 400;
  }
}

function decodeTextDataUrl(dataUrl) {
  const match = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const isBase64 = /;base64/i.test(match[2] ?? "");
  try {
    return isBase64 ? Buffer.from(match[3], "base64").toString("utf8") : decodeURIComponent(match[3]);
  } catch {
    return null;
  }
}

/**
 * @param {object} body parsed JSON request body
 * @returns {{role:string, content:any}[]} messages (without the server's own system prompt)
 */
export function buildAnalyzeMessages(body) {
  // Chat-style callers already provide messages: pass them through untouched.
  if (Array.isArray(body?.messages) && body.messages.length > 0) return body.messages;

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, LIMITS.maxPromptChars) : "";
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!prompt && attachments.length === 0) {
    throw new AnalyzeRequestError("Attach a file or type a prompt.");
  }
  if (attachments.length > LIMITS.maxAttachments) {
    throw new AnalyzeRequestError(`At most ${LIMITS.maxAttachments} attachments are allowed.`);
  }

  const parts = [{ type: "text", text: prompt || "Analyze the attached material." }];
  const problems = [];
  let textBudget = LIMITS.maxTextChars;

  for (const a of attachments) {
    const name = String(a?.name ?? "attachment").replace(/[\r\n]+/g, " ").slice(0, 120);
    const mime = String(a?.mime ?? "");

    if (typeof a?.extractedText === "string" && a.extractedText.trim()) {
      const text = a.extractedText.slice(0, Math.max(0, textBudget));
      textBudget -= text.length;
      parts.push({ type: "text", text: `--- Attachment: ${name} ---\n${text}${text.length < a.extractedText.length ? "\n[truncated]" : ""}` });
      continue;
    }

    if (a?.kind === "image" && typeof a.dataUrl === "string") {
      if (!IMAGE_DATA_URL.test(a.dataUrl) || a.dataUrl.length > LIMITS.maxImageDataUrlChars) {
        problems.push(`${name}: only PNG, JPEG or WebP images under about 9 MB are supported`);
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
      continue;
    }

    if (typeof a?.dataUrl === "string" && (TEXT_MIME.test(mime) || /\.(txt|md|csv|json)$/i.test(name))) {
      const decoded = decodeTextDataUrl(a.dataUrl);
      if (decoded === null || !decoded.trim()) {
        problems.push(`${name}: the file could not be read as text`);
        continue;
      }
      const text = decoded.slice(0, Math.max(0, textBudget));
      textBudget -= text.length;
      parts.push({ type: "text", text: `--- Attachment: ${name} ---\n${text}${text.length < decoded.length ? "\n[truncated]" : ""}` });
      continue;
    }

    problems.push(
      /pdf/i.test(mime) || /\.pdf$/i.test(name)
        ? `${name}: PDF text was not extracted (scanned PDFs have no selectable text)`
        : `${name}: this file type is not supported`,
    );
  }

  if (problems.length > 0) {
    throw new AnalyzeRequestError(`Some attachments cannot be analysed: ${problems.join("; ")}.`);
  }

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: parts.length === 1 ? parts[0].text : parts },
  ];
}
