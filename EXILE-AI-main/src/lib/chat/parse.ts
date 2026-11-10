/**
 * Splits a chat message into prose and fenced code blocks.
 *
 * Works on partial text, so it is safe to call on every streamed chunk: a code fence that has
 * been opened but not yet closed is returned as an incomplete code block instead of raw
 * backticks. Code is returned exactly as written (indentation and blank lines preserved) and
 * never includes the fence lines, language label or any surrounding explanation.
 */

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "code"; language: string; filename: string | null; code: string; complete: boolean };

const OPEN = /^ {0,3}(`{3,})[ \t]*([^`\r\n]*)$/;

export interface FenceInfo {
  language: string;
  filename: string | null;
}

/** Understands: `ts`, `tsx src/App.tsx`, `python:main.py`, `html title="index.html"`, `js filename=a.js`. */
export function parseFenceInfo(info: string): FenceInfo {
  const raw = info.trim();
  if (!raw) return { language: "", filename: null };

  let filename: string | null = null;
  const named = /(?:title|filename|file)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(raw);
  if (named) filename = named[1] ?? named[2] ?? named[3] ?? null;

  const rest = raw.replace(/(?:title|filename|file)\s*=\s*(?:"[^"]+"|'[^']+'|\S+)/gi, " ").trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  let language = "";
  if (tokens[0]) {
    const colon = tokens[0].indexOf(":");
    if (colon > 0) {
      language = tokens[0].slice(0, colon);
      filename ??= tokens[0].slice(colon + 1) || null;
    } else {
      language = tokens[0];
    }
  }
  if (!filename) {
    const fileLike = tokens.slice(1).find((t) => /^[\w@./\\-]+\.[A-Za-z0-9]{1,8}$/.test(t));
    if (fileLike) filename = fileLike;
  }
  if (filename) filename = filename.replace(/\\/g, "/").split("/").pop() || null;
  return { language: language.toLowerCase().replace(/[^a-z0-9_+#.-]/g, ""), filename };
}

export function parseMessage(input: string): MessagePart[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const parts: MessagePart[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let fenceLength = 0;
  let info: FenceInfo = { language: "", filename: null };

  const flushProse = () => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) parts.push({ type: "text", text });
    prose = [];
  };

  for (const line of lines) {
    if (code === null) {
      const m = OPEN.exec(line);
      if (m) {
        flushProse();
        code = [];
        fenceLength = m[1].length;
        info = parseFenceInfo(m[2]);
      } else {
        prose.push(line);
      }
      continue;
    }
    const close = new RegExp(`^ {0,3}\`{${fenceLength},}[ \\t]*$`);
    if (close.test(line)) {
      parts.push({ type: "code", language: info.language, filename: info.filename, code: code.join("\n"), complete: true });
      code = null;
    } else {
      code.push(line);
    }
  }

  if (code !== null) {
    parts.push({ type: "code", language: info.language, filename: info.filename, code: code.join("\n"), complete: false });
  } else {
    flushProse();
  }
  return parts;
}

/** Splits prose into plain text and http(s) links so links can be made clickable without HTML. */
export type InlinePart = { type: "text"; text: string } | { type: "link"; text: string; href: string };

export function splitLinks(text: string): InlinePart[] {
  const out: InlinePart[] = [];
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let cursor = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Trailing punctuation belongs to the sentence, not the link.
    const trail = /[.,;:!?)\]}]+$/.exec(url);
    if (trail) url = url.slice(0, url.length - trail[0].length);
    if (start > cursor) out.push({ type: "text", text: text.slice(cursor, start) });
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") out.push({ type: "link", text: url, href: parsed.href });
      else out.push({ type: "text", text: url });
    } catch {
      out.push({ type: "text", text: url });
    }
    cursor = start + url.length;
  }
  if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor) });
  return out;
}
