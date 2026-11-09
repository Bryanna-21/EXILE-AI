import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export const PDF_LIMITS = { pages: 40, chars: 60000 } as const;

export interface PdfText {
  text: string;
  pages: number;
  truncated: boolean;
}

/** Extract selectable text from a PDF. Scanned PDFs return an empty string (no OCR is performed). */
export async function extractPdfText(file: File): Promise<PdfText> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const limit = Math.min(pdf.numPages, PDF_LIMITS.pages);
  const pages: string[] = [];
  let size = 0;
  for (let n = 1; n <= limit; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
    pages.push(text);
    size += text.length;
    if (size >= PDF_LIMITS.chars) break;
  }
  const joined = pages.join("\n");
  return { text: joined.slice(0, PDF_LIMITS.chars), pages: pdf.numPages, truncated: pdf.numPages > pages.length || joined.length > PDF_LIMITS.chars };
}
