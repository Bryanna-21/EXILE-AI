import { useEffect, useLayoutEffect, type RefObject } from "react";
import { Camera, FileText, Loader2, Mic, Paperclip, Send, X } from "lucide-react";
import { formatBytes } from "@/lib/chat/files";
import type { TranscriptTurn } from "@/lib/conversation";
import { buildQuote } from "@/lib/chat/ops";
import "./chat.css";

export interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  kind: "image" | "pdf" | "text";
  /** Image data URL for the thumbnail. */
  dataUrl?: string;
}

export interface ChatComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  attachments: ComposerAttachment[];
  onRemoveAttachment: (id: string) => void;
  onPickFiles: (files: FileList | null) => void;
  maxAttachments: number;
  accept: string;
  attachmentError?: string;
  onMic?: () => void;
  replyTo: TranscriptTurn | null;
  onCancelReply: () => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  fileInputRef: RefObject<HTMLInputElement>;
  placeholder?: string;
}

const MAX_ROWS_PX = 168;

/** Multiline composer: Enter sends, Shift+Enter adds a line, attachments with previews, reply bar. */
const ChatComposer = (p: ChatComposerProps) => {
  const canSend = !p.busy && (p.value.trim().length > 0 || p.attachments.length > 0);

  useLayoutEffect(() => {
    const el = p.inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [p.value, p.inputRef]);

  useEffect(() => { if (p.replyTo) p.inputRef.current?.focus(); }, [p.replyTo, p.inputRef]);

  return (
    <>
      {p.replyTo && (
        <div className="mx-auto mb-1.5 flex w-full max-w-4xl items-start gap-2 rounded-lg border-l-2 border-cyan-300/70 bg-slate-950/80 px-3 py-1.5 text-xs text-slate-300" data-testid="reply-bar">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] tracking-widest text-cyan-300/70">REPLYING TO {p.replyTo.role === "user" ? "YOU" : "EXILE"}</div>
            <div className="truncate">{buildQuote(p.replyTo.text)}</div>
          </div>
          <button type="button" onClick={p.onCancelReply} aria-label="Cancel reply" className="rounded p-1 text-slate-300 hover:bg-slate-800"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {p.attachments.length > 0 && (
        <ul className="mx-auto mb-2 flex w-full max-w-4xl flex-wrap gap-2" aria-label="Attached files" data-testid="attachment-previews">
          {p.attachments.map((a) => (
            <li key={a.id} title={a.name} className="flex max-w-full items-center gap-2 rounded-lg border border-[#c4a253]/50 bg-[#080907] p-1 pr-2 text-xs text-[#f5edda]">
              {a.kind === "image" && a.dataUrl
                ? <img src={a.dataUrl} alt="" className="h-9 w-9 rounded object-cover" />
                : <span className="flex h-9 w-9 items-center justify-center rounded bg-[#c4a253]/15">{a.kind === "image" ? <Camera className="h-4 w-4 text-[#e0c478]" /> : <FileText className="h-4 w-4 text-[#e0c478]" />}</span>}
              <span className="min-w-0"><span className="block max-w-40 truncate sm:max-w-56">{a.name}</span><span className="block text-[10px] text-[#a9a18e]">{formatBytes(a.size)}</span></span>
              <button type="button" aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} onClick={() => p.onRemoveAttachment(a.id)} className="ml-1 text-[#e0c478] hover:text-red-300"><X className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      {p.attachmentError && <p role="status" className="mx-auto mb-2 w-full max-w-4xl text-xs text-amber-300">{p.attachmentError}</p>}
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSend) p.onSend(); }}
        className="mx-auto flex w-full max-w-4xl items-end gap-2 rounded-xl border border-cyan-500/35 bg-slate-950/90 px-3 py-2 shadow-[0_0_30px_rgba(34,211,238,0.15)] backdrop-blur-xl"
        aria-label="Message composer"
      >
        <input ref={p.fileInputRef} type="file" multiple className="hidden" accept={p.accept} aria-label="Attach files input" onChange={(e) => p.onPickFiles(e.target.files)} />
        <button type="button" onClick={() => p.fileInputRef.current?.click()} disabled={p.attachments.length >= p.maxAttachments || p.busy} className="mb-1 text-[#e0c478] hover:text-[#f5edda] disabled:opacity-40" aria-label="Attach files" title={p.attachments.length >= p.maxAttachments ? `Up to ${p.maxAttachments} files` : "Attach files"}>
          <Paperclip className="h-4 w-4" />
        </button>
        {p.onMic && (
          <button type="button" onClick={p.onMic} className="mb-1 text-cyan-300/80 hover:text-cyan-100" aria-label="Voice input"><Mic className="h-4 w-4" /></button>
        )}
        <textarea
          ref={p.inputRef}
          value={p.value}
          rows={1}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) p.onSend();
            }
          }}
          placeholder={p.placeholder ?? "Speak or type a directive…"}
          aria-label="Message"
          enterKeyHint="send"
          className="max-h-[168px] min-h-[24px] flex-1 resize-none self-center bg-transparent py-1 text-sm leading-6 text-cyan-50 outline-none placeholder:text-cyan-500/40"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={p.busy ? "Sending" : "Send message"}
          title={p.busy ? "EXILE is replying…" : "Send (Enter)"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-cyan-300 transition hover:bg-cyan-500/15 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {p.busy ? <Loader2 className="chat-spin h-4 w-4" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </>
  );
};

export default ChatComposer;
