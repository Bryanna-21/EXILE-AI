/**
 * Does a chat message ask for a file? This mirrors local/artifacts/request.mjs, which is the
 * authority on the server (test/artifact-client.test.mjs checks that the two agree on a corpus).
 * It is conservative: ordinary conversation is never mistaken for a file request.
 */

export interface ArtifactIntent {
  format: string;
  label: string;
  unsupported?: false;
}
export interface UnsupportedIntent {
  unsupported: true;
  message: string;
}

const CREATE_VERB = /\b(create|generate|make|prepare|write|build|export|produce|draft|attach|compile|design|render|put together|turn|draw|sketch|illustrate)\b/i;
const SEND_NOUN = /\bsend\s+(?:me\s+)?(?:a|an|the)\b/i;

const FORMAT_PATTERNS: [string, string, RegExp][] = [
  ["pptx", "PowerPoint presentation", /\b(?:pptx|powerpoint|power point|slide ?deck|slides?|presentation|pitch deck)\b/i],
  ["xlsx", "Excel workbook", /\b(?:xlsx|excel|workbook|spreadsheet)\b/i],
  ["csv", "CSV file", /\b(?:csv|comma[- ]separated)\b/i],
  ["json", "JSON file", /\bjson\b/i],
  ["xml", "XML file", /\bxml\b/i],
  ["docx", "Word document", /\b(?:docx|word (?:document|file|doc|format)|ms word|\.doc)\b/i],
  ["rtf", "RTF document", /\b(?:rtf|rich text)\b/i],
  ["html", "HTML page", /\b(?:html page|html file|\.html|web ?page|landing page)\b/i],
  ["md", "Markdown file", /\b(?:markdown|\.md)\b/i],
  ["zip", "ZIP archive", /\b(?:zip|project folder|source[- ]code package|code package)\b/i],
  ["mp4", "MP4 video", /\b(?:mp4|video|animation|explainer video|slideshow video)\b/i],
  ["wav", "WAV audio", /\b(?:wav|sound effect|beep|chime|audio clip)\b/i],
  ["mp3", "MP3 audio", /\b(?:mp3|narrat(?:ion|ed)|voice ?over|read aloud|text[- ]to[- ]speech|speech)\b/i],
  ["png", "PNG image", /\b(?:png|image|picture|illustration|poster|banner|chart|graph|diagram|logo|infographic|svg)\b/i],
  ["txt", "text file", /\b(?:plain text|text file|\.txt)\b/i],
  ["pdf", "PDF", /\b(?:pdf|document|report|resume|résumé|cv|invoice|letter|file)\b/i],
];

const LABELS: Record<string, string> = { jpg: "JPEG image", webp: "WebP image", svg: "SVG image", webm: "WebM video" };

export function detectArtifactIntent(input: string): ArtifactIntent | UnsupportedIntent | null {
  const text = String(input || "").trim();
  if (!text || text.length > 4000) return null;
  if (/^\s*(?:how|what|why|when|where|which|who|is|are|does|do)\b/i.test(text) && !/\b(?:please|can you|could you|will you)\b/i.test(text)) return null;
  if (!CREATE_VERB.test(text) && !SEND_NOUN.test(text)) return null;
  if (/\b(?:\.?ppt\b(?!x)|\.?xls\b(?!x)|google (?:docs?|sheets?|slides?)|keynote|pages file|numbers file|\.psd|\.ai file|autocad|\.dwg)\b/i.test(text)) {
    return { unsupported: true, message: "I can't create that format yet. I can create PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, JSON, XML, HTML, RTF, Markdown, text, ZIP, PNG/JPEG/WebP/SVG images, WAV/MP3 audio and MP4/WebM video." };
  }
  for (const [format, label, re] of FORMAT_PATTERNS) {
    if (!re.test(text)) continue;
    let chosen = format;
    if (format === "png") {
      if (/\b(?:jpe?g)\b/i.test(text)) chosen = "jpg";
      else if (/\bwebp\b/i.test(text)) chosen = "webp";
      else if (/\bsvg\b/i.test(text)) chosen = "svg";
    }
    if (format === "mp4" && /\bwebm\b/i.test(text)) chosen = "webm";
    if (format === "mp3" && /\bwav\b/i.test(text)) chosen = "wav";
    return { format: chosen, label: chosen === format ? label : LABELS[chosen] ?? label };
  }
  return null;
}

/** Plain, honest wording for each real pipeline stage (the UI never invents progress). */
export const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting for a free worker",
  understanding: "Understanding the request",
  researching: "Researching",
  generating: "Generating",
  processing: "Processing",
  validating: "Validating",
  repairing: "Repairing",
  saving: "Saving",
  delivering: "Delivering",
  completed: "Completed",
  failed: "Failed",
};
