import { useEffect, useMemo, useState } from "react";
import { Copy, Download, ExternalLink, Eye, File as FileIcon, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, FileVideo } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChatFile } from "@/lib/chat/mediaStore";
import { copyText, downloadBlob, openBlob } from "@/lib/chat/dom";
import { fileExtension, formatBytes, isTextual, type FileKind } from "@/lib/chat/files";
import { languageInfo } from "@/lib/chat/languages";
import { highlightCode } from "@/lib/chat/highlight";

const btn =
  "inline-flex h-7 items-center gap-1 rounded-md border border-[#c4a253]/40 px-2 text-[11px] text-[#f0dfaa] transition hover:bg-[#c4a253]/15 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e6c875]";

const ICONS: Record<FileKind, typeof FileIcon> = {
  image: FileIcon, pdf: FileText, text: FileText, code: FileCode, data: FileSpreadsheet,
  document: FileText, archive: FileArchive, audio: FileAudio, video: FileVideo, other: FileIcon,
};

const PREVIEW_CHARS = 20_000;

function useFileText(file: ChatFile, enabled: boolean) {
  const [text, setText] = useState<string | null>(file.text ?? null);
  useEffect(() => {
    if (!enabled || text !== null || !file.file) return;
    let live = true;
    file.file.text().then((t) => live && setText(t)).catch(() => live && setText(""));
    return () => { live = false; };
  }, [enabled, file, text]);
  return text;
}

function PdfFrame({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <iframe src={url} title={`Preview of ${name}`} className="h-[65vh] w-full rounded border border-[#c4a253]/30 bg-white" data-testid="pdf-frame" />;
}

/** File/document card: name, extension, size, icon, preview, open, download and copy contents. */
const FileCard = ({ file }: { file: ChatFile }) => {
  const [open, setOpen] = useState(false);
  const [showText, setShowText] = useState(false);
  const Icon = ICONS[file.kind];
  const ext = fileExtension(file.name).toUpperCase();
  const textual = isTextual(file.kind);
  const isPdf = file.kind === "pdf";
  const previewable = textual || isPdf || !!file.text;
  const text = useFileText(file, open && (textual || showText));
  const hasContents = textual || (isPdf && !!file.text);
  const lang = languageInfo(fileExtension(file.name));
  const shown = text === null ? null : text.slice(0, PREVIEW_CHARS);

  const download = () => {
    if (file.file) downloadBlob(file.file, file.name);
    else toast.error("This file is no longer available to download.");
  };
  const openTab = () => {
    if (!file.file || !openBlob(file.file)) toast.error("The browser blocked opening the file. Use Download instead.");
  };
  const copyContents = async () => {
    const body = file.text ?? (file.file ? await file.file.text() : "");
    if (body && (await copyText(body))) toast.success(isPdf ? "Extracted text copied." : "File contents copied.");
    else toast.error("Nothing could be copied.");
  };

  return (
    <div className="my-1.5 w-full max-w-sm rounded-lg border border-[#c4a253]/40 bg-[#080907] p-2 text-left text-[#f5edda]" data-testid="file-card">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#c4a253]/15 text-[#e0c478]"><Icon className="h-5 w-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm" title={file.name} data-testid="file-name">{file.name}</div>
          <div className="text-[11px] text-[#a9a18e]">{ext || "FILE"} · {formatBytes(file.size)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={btn} onClick={() => setOpen(true)} disabled={!previewable} title={previewable ? "Preview" : "No preview for this file type"}>
          <Eye className="h-3.5 w-3.5" /> Preview
        </button>
        <button type="button" className={btn} onClick={openTab} disabled={!file.file || !(isPdf || textual)} title="Open in a new tab"><ExternalLink className="h-3.5 w-3.5" /> Open</button>
        <button type="button" className={btn} onClick={download} disabled={!file.file} aria-label={`Download ${file.name}`}><Download className="h-3.5 w-3.5" /> Download</button>
        {hasContents && <button type="button" className={btn} onClick={() => void copyContents()}><Copy className="h-3.5 w-3.5" /> {isPdf ? "Copy text" : "Copy"}</button>}
      </div>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setShowText(false); }}>
        <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-4xl flex-col gap-2 border-[#c4a253]/40 bg-[#080907] p-3 text-[#f5edda]">
          <DialogTitle className="truncate pr-6 text-sm">{file.name}</DialogTitle>
          <DialogDescription className="text-[11px] text-[#a9a18e]">{ext || "FILE"} · {formatBytes(file.size)}{isPdf ? " · preview uses your browser's PDF viewer" : ""}</DialogDescription>
          <div className="min-h-0 flex-1 overflow-auto">
            {isPdf && file.file && !showText && <PdfFrame blob={file.file} name={file.name} />}
            {(!isPdf || showText) && (
              shown === null ? <p className="p-4 text-sm text-[#a9a18e]">Loading…</p>
              : shown === "" ? <p className="p-4 text-sm text-[#a9a18e]">This file has no readable text.</p>
              : (
                <pre className="chat-code-body max-h-[65vh] overflow-auto rounded border border-[#c4a253]/25 bg-slate-950 p-3 text-[12.5px] leading-5 text-slate-100" data-testid="file-preview-text">
                  <code className="block whitespace-pre font-mono">
                    {(file.kind === "code" || file.kind === "data" ? highlightCode(shown, lang.id) : [{ text: shown, cls: "" }]).map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}
                  </code>
                </pre>
              )
            )}
            {text && text.length > PREVIEW_CHARS && (!isPdf || showText) && <p className="mt-1 text-[11px] text-[#a9a18e]">Preview shows the first {PREVIEW_CHARS.toLocaleString()} characters. Download for the full file.</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {isPdf && file.text && <button type="button" className={btn} onClick={() => setShowText((v) => !v)}>{showText ? "Show document" : "Show extracted text"}</button>}
            <button type="button" className={btn} onClick={download} disabled={!file.file}><Download className="h-3.5 w-3.5" /> Download</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FileCard;
