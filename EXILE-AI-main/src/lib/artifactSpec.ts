/** Turns text typed into the Artifacts panel into the declarative spec each generator expects. */

/** Either `spec` or `error` is set (a plain shape, because the project compiles with strict:false). */
export interface SpecResult { spec?: Record<string, unknown>; error?: string }

const AUDIO_PRESETS = new Set(["beep", "chime", "success", "error", "click"]);

export function buildSpec(format: string, text: string, title = ""): SpecResult {
  const body = text.trim();
  if (!body) return { error: "Type or paste some content first." };
  const t = title.trim();
  switch (format) {
    case "pdf": case "docx": case "txt": case "md": case "rtf": case "html":
      return { spec: { content: body, ...(t ? { title: t } : {}) } };
    case "csv": case "xlsx": case "xml": case "pptx":
      return { spec: { content: body, ...(t ? { title: t } : {}) } };
    case "json":
      return { spec: { content: body } };
    case "svg": case "png": case "jpg": case "webp": {
      if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body)) return { spec: { svg: body } };
      const [first, ...rest] = body.split("\n");
      return { spec: { procedural: { type: "card", title: first.slice(0, 160), subtitle: rest.join(" ").trim().slice(0, 240), width: 1280, height: 720 } } };
    }
    case "wav": case "mp3": case "ogg": case "m4a":
      return AUDIO_PRESETS.has(body.toLowerCase())
        ? { spec: { preset: body.toLowerCase() } }
        : { spec: { text: body } };
    case "mp4": case "webm":
      return { spec: { text: body, title: t, transition: "fade", captions: true } };
    case "zip": {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return { error: 'For a ZIP, paste JSON like [{"path":"readme.txt","content":"hello"}].' }; }
      const files = Array.isArray(parsed) ? parsed : (parsed as { files?: unknown })?.files;
      if (!Array.isArray(files) || !files.length) return { error: "The JSON needs a non-empty list of files." };
      return { spec: { files, ...(t ? { projectName: t } : {}) } };
    }
    default:
      return { error: `Unsupported format "${format}".` };
  }
}

export const CONTENT_HINTS: Record<string, string> = {
  pdf: "Markdown: # Title, ## Sections, - bullets, | tables |",
  docx: "Markdown: # Title, ## Sections, - bullets, | tables |",
  txt: "Plain text", md: "Markdown", rtf: "Markdown (converted to RTF)", html: "Markdown (converted to a safe HTML page)",
  csv: "CSV text with a header row", xlsx: "Markdown tables (## Sheet name above each) or CSV text",
  json: "A JSON value", xml: "XML with one root element (no DOCTYPE)",
  pptx: "# Deck title, then ## Slide title with - bullets (a line 'Notes: ...' adds speaker notes)",
  svg: "SVG markup, or a title line to make a title card", png: "SVG markup, or a title line to make a title card",
  jpg: "SVG markup, or a title line to make a title card", webp: "SVG markup, or a title line to make a title card",
  wav: "A preset (beep, chime, success, error, click) or text to speak (needs a local speech engine)",
  mp3: "A preset or text to speak (needs a local speech engine)", ogg: "A preset or text to speak", m4a: "A preset or text to speak",
  mp4: "Storyboard: one scene per paragraph (narration + on-screen caption)", webm: "Storyboard: one scene per paragraph",
  zip: 'JSON: [{"path":"src/app.js","content":"..."}]',
};

/** Conversions the engine supports (mirrors local/artifacts/engine.mjs convertBuffer). */
export function conversionTargets(format: string): string[] {
  switch (format) {
    case "png": case "jpg": case "webp": return ["png", "jpg", "webp"].filter((f) => f !== format);
    case "svg": return ["png", "jpg", "webp"];
    case "wav": case "mp3": case "ogg": case "m4a": return ["wav", "mp3", "ogg", "m4a"].filter((f) => f !== format);
    case "mp4": return ["webm", "mp3", "wav", "png"];
    case "webm": return ["mp4", "mp3", "wav", "png"];
    case "docx": return ["pdf", "txt"];
    case "rtf": case "pptx": return ["pdf"];
    case "xlsx": return ["csv", "pdf"];
    case "pdf": return ["txt"];
    case "md": return ["pdf", "docx", "html", "rtf", "txt"];
    case "txt": return ["pdf", "docx", "html", "rtf", "md"];
    case "csv": return ["xlsx", "json"];
    case "json": return ["csv"];
    default: return [];
  }
}

export const KIND_TEXT_EDITABLE = new Set(["document", "data", "presentation", "archive"]);
