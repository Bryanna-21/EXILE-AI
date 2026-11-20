import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { ChatFile } from "@/lib/chat/mediaStore";

interface Props {
  file: ChatFile;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRegenerate: (prompt: string, reference: ChatFile) => void;
}

export default function ChatImageCanvas({ file, busy, error, onClose, onRegenerate }: Props) {
  const [prompt, setPrompt] = useState(file.prompt ?? "");

  useEffect(() => {
    setPrompt(file.prompt ?? "");
  }, [file.id, file.prompt]);

  return (
    <section
      className="mt-3 w-full overflow-hidden rounded-xl border border-[#c4a253]/40 bg-[#080907] text-[#f5edda]"
      aria-label="Image Canvas"
      data-testid="chat-image-canvas"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[#c4a253]/20 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-[0.22em] text-[#e6c875]">IMAGE CANVAS</p>
          <p className="truncate text-[11px] text-slate-400">{file.name}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-white/10"
          aria-label="Close Image Canvas"
          title="Close Image Canvas"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)]">
        <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/50 p-2">
          {file.dataUrl ? (
            <img
              src={file.dataUrl}
              alt={file.prompt || file.name}
              className="max-h-[480px] max-w-full object-contain"
            />
          ) : (
            <p className="text-xs text-slate-400">Image preview is unavailable.</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={`image-canvas-prompt-${file.id}`} className="text-[11px] font-medium tracking-wider text-[#e6c875]">
            IMAGE PROMPT
          </label>
          <textarea
            id={`image-canvas-prompt-${file.id}`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={7}
            disabled={busy}
            className="min-h-36 w-full resize-y rounded-lg border border-[#c4a253]/30 bg-black/40 p-3 text-sm text-slate-100 outline-none focus:border-[#e6c875] disabled:opacity-50"
            placeholder="Describe the image you want to create…"
          />
          {error && (
            <p role="alert" className="rounded-md border border-red-400/30 bg-red-950/30 p-2 text-xs text-red-200">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => onRegenerate(prompt.trim(), file)}
            disabled={busy || !prompt.trim()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#c4a253]/50 bg-[#c4a253]/15 px-3 py-2 text-xs font-semibold text-[#f0dfaa] transition hover:bg-[#c4a253]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            {busy ? "Regenerating…" : "Regenerate image"}
          </button>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Regeneration replaces this image in the same message. Other images and attachments are preserved.
          </p>
        </div>
      </div>
    </section>
  );
}
