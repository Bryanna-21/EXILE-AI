import { useState } from "react";
import { Copy, Download, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChatFile } from "@/lib/chat/mediaStore";
import { canCopyImage, copyImage, dataUrlToBlob, downloadBlob } from "@/lib/chat/dom";
import { formatBytes } from "@/lib/chat/files";

const btn =
  "inline-flex h-7 items-center gap-1 rounded-md border border-[#c4a253]/40 px-2 text-[11px] text-[#f0dfaa] transition hover:bg-[#c4a253]/15 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e6c875]";

const blobOf = async (f: ChatFile): Promise<Blob | null> => f.file ?? (f.dataUrl ? dataUrlToBlob(f.dataUrl) : null);

/** Inline image with expand, download and copy. */
const ImageCard = ({ file }: { file: ChatFile }) => {
  const [open, setOpen] = useState(false);
  const src = file.dataUrl;
  if (!src) return null;
  const alt = file.prompt ?? file.name;

  const download = async () => {
    const blob = await blobOf(file);
    if (blob) downloadBlob(blob, file.name);
    else toast.error("This image is no longer available to download.");
  };
  const copy = async () => {
    const blob = await blobOf(file);
    if (blob && (await copyImage(blob))) toast.success("Image copied.");
    else toast.error("The browser did not allow copying this image. Use Download instead.");
  };

  return (
    <figure className="my-2 w-full max-w-sm overflow-hidden rounded-lg border border-[#c4a253]/40 bg-[#080907] text-left" data-testid="image-card">
      <button type="button" onClick={() => setOpen(true)} aria-label={`Expand image ${file.name}`} className="block w-full cursor-zoom-in bg-[radial-gradient(ellipse_at_center,_#282216_0%,_#080907_100%)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e6c875]">
        <img src={src} alt={alt} className="mx-auto max-h-72 w-auto rounded-t-lg object-contain" loading="lazy" />
      </button>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
        <span className="min-w-0 truncate text-[11px] text-[#c6a75b]" title={file.name}>{file.name}{file.size ? ` · ${formatBytes(file.size)}` : ""}</span>
        <span className="flex gap-1.5">
          <button type="button" className={btn} onClick={() => setOpen(true)} aria-label="Expand image"><Maximize2 className="h-3.5 w-3.5" /></button>
          <button type="button" className={btn} onClick={() => void download()} aria-label={`Download ${file.name}`}><Download className="h-3.5 w-3.5" /></button>
          <button type="button" className={btn} onClick={() => void copy()} disabled={!canCopyImage()} aria-label="Copy image" title={canCopyImage() ? "Copy image" : "This browser cannot copy images"}><Copy className="h-3.5 w-3.5" /></button>
        </span>
      </figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-5xl flex-col gap-2 border-[#c4a253]/40 bg-[#080907] p-3 text-[#f5edda]">
          <DialogTitle className="truncate pr-6 text-sm">{file.name}</DialogTitle>
          <DialogDescription className="sr-only">Expanded image</DialogDescription>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
            <img src={src} alt={alt} className="max-h-[75vh] max-w-full object-contain" data-testid="image-expanded" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={() => void download()}><Download className="h-3.5 w-3.5" /> Download</button>
            <button type="button" className={btn} onClick={() => void copy()} disabled={!canCopyImage()}><Copy className="h-3.5 w-3.5" /> Copy image</button>
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
};

export default ImageCard;
