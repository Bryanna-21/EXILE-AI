import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, Clock, Copy, CornerUpLeft, MoreHorizontal, Pencil, RefreshCw, RotateCcw, TextSelect, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { TranscriptTurn } from "@/lib/conversation";
import { parseMessage, splitLinks } from "@/lib/chat/parse";
import { buildQuote, isPlaceholder, type DeliveryStatus } from "@/lib/chat/ops";
import { stripAttachmentLabel } from "@/lib/chat/files";
import { copyText, selectElementText } from "@/lib/chat/dom";
import type { ChatFile } from "@/lib/chat/mediaStore";
import CodeBlock from "./CodeBlock";
import FileCard from "./FileCard";
import ImageCard from "./ImageCard";

export interface MessageHandlers {
  onReply: (turn: TranscriptTurn) => void;
  onEditSave: (id: string, text: string) => void;
  onResend: (id: string) => void;
  onRegenerate: (id: string) => void;
  onDelete: (id: string) => void;
  onJumpTo: (id: string) => void;
}

interface Props extends MessageHandlers {
  turn: TranscriptTurn;
  status: DeliveryStatus | null;
  busy: boolean;
  streaming: boolean;
  thinking: boolean;
  files: ChatFile[];
  quoted: TranscriptTurn | null;
  canRegenerate: boolean;
}

const STATUS: Record<DeliveryStatus, { label: string; icon: JSX.Element }> = {
  sending: { label: "Sending", icon: <Clock className="chat-spin h-3 w-3" aria-hidden /> },
  sent: { label: "Saved", icon: <Check className="h-3.5 w-3.5" aria-hidden /> },
  answered: { label: "Answered", icon: <CheckCheck className="h-3.5 w-3.5 text-cyan-300" aria-hidden /> },
  "answered-local": { label: "Answered locally (cloud unavailable)", icon: <CheckCheck className="h-3.5 w-3.5 text-amber-300" aria-hidden /> },
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Rich({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.type === "link"
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-100">{p.text}</a>
          : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

const itemCls = "gap-2 text-xs text-cyan-100 focus:bg-cyan-500/15 focus:text-cyan-50";

const MessageBubble = ({ turn, status, busy, streaming, thinking, files, quoted, canRegenerate, ...h }: Props) => {
  const isUser = turn.role === "user";
  const bodyRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const selectAfterClose = useRef(false);

  const { text: visibleText, names } = useMemo(() => stripAttachmentLabel(turn.text), [turn.text]);
  const parts = useMemo(() => parseMessage(visibleText), [visibleText]);
  const missingNames = names.filter((n) => !files.some((f) => f.name === n));
  const empty = !thinking && isPlaceholder(turn.text);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const startEdit = () => { setDraft(visibleText); setEditing(true); };
  const saveEdit = () => {
    const next = draft.trim();
    if (!next) return toast.error("A message cannot be empty.");
    setEditing(false);
    if (next === visibleText.trim()) return;
    h.onEditSave(turn.id, next);
  };

  const copyMessage = async () => {
    if (await copyText(visibleText)) toast.success("Message copied.");
    else toast.error("Copy was blocked by the browser.");
  };
  const selectMessage = () => { if (bodyRef.current) selectElementText(bodyRef.current); };

  const generated = files.filter((f) => f.kind === "image");
  const others = files.filter((f) => f.kind !== "image");
  const st = status ? STATUS[status] : null;

  return (
    <div
      className={`chat-row flex w-full ${isUser ? "justify-end" : "justify-start"} ${isUser ? "chat-in-user" : "chat-in-exile"}`}
      data-turn-id={turn.id}
      data-role={turn.role}
      data-testid={`message-${turn.role}`}
    >
      <article
        className={`chat-bubble relative rounded-2xl px-3.5 py-2 shadow-sm ${
          isUser
            ? "max-w-[88%] rounded-br-md border border-cyan-400/35 bg-cyan-500/15 text-cyan-50 sm:max-w-[78%]"
            : "max-w-[95%] rounded-bl-md border border-cyan-500/20 bg-slate-900/75 text-cyan-100/95 sm:max-w-[88%]"
        } ${streaming ? "chat-streaming" : ""}`}
        aria-label={isUser ? "Your message" : "EXILE message"}
      >
        <header className="mb-0.5 flex items-center justify-between gap-3">
          <span className="text-[9px] font-medium tracking-[0.3em] text-cyan-300/60">{isUser ? "YOU" : "EXILE"}</span>
          {!editing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="Message actions" className="chat-actions-trigger -mr-1.5 flex h-8 w-8 items-center justify-center rounded-full text-cyan-200/80 hover:bg-cyan-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={isUser ? "end" : "start"}
                className="min-w-44 border-cyan-500/30 bg-slate-950 text-cyan-100"
                onCloseAutoFocus={(e) => {
                  // Select text must run after the menu has returned focus, or the selection is cleared.
                  if (!selectAfterClose.current) return;
                  selectAfterClose.current = false;
                  e.preventDefault();
                  selectMessage();
                }}
              >
                <DropdownMenuItem className={itemCls} onSelect={() => h.onReply(turn)}><CornerUpLeft className="h-3.5 w-3.5" /> Reply</DropdownMenuItem>
                <DropdownMenuItem className={itemCls} onSelect={() => void copyMessage()} disabled={empty || thinking}><Copy className="h-3.5 w-3.5" /> Copy message</DropdownMenuItem>
                <DropdownMenuItem className={itemCls} onSelect={() => { selectAfterClose.current = true; }} disabled={empty || thinking}><TextSelect className="h-3.5 w-3.5" /> Select text</DropdownMenuItem>
                {(isUser || canRegenerate) && <DropdownMenuSeparator className="bg-cyan-500/20" />}
                {isUser && <DropdownMenuItem className={itemCls} onSelect={startEdit} disabled={busy}><Pencil className="h-3.5 w-3.5" /> Edit</DropdownMenuItem>}
                {isUser && <DropdownMenuItem className={itemCls} onSelect={() => h.onResend(turn.id)} disabled={busy}><RotateCcw className="h-3.5 w-3.5" /> Resend</DropdownMenuItem>}
                {!isUser && canRegenerate && <DropdownMenuItem className={itemCls} onSelect={() => h.onRegenerate(turn.id)} disabled={busy}><RefreshCw className="h-3.5 w-3.5" /> Regenerate</DropdownMenuItem>}
                <DropdownMenuSeparator className="bg-cyan-500/20" />
                <DropdownMenuItem className={`${itemCls} text-red-300 focus:text-red-200`} onSelect={() => h.onDelete(turn.id)} disabled={busy}><Trash2 className="h-3.5 w-3.5" /> Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>

        {quoted && (
          <button type="button" onClick={() => h.onJumpTo(quoted.id)} className="mb-1.5 block w-full rounded-md border-l-2 border-cyan-300/70 bg-slate-950/50 px-2 py-1 text-left text-[12px] text-slate-300 hover:bg-slate-950/70" aria-label="Jump to the message being replied to" data-testid="quoted-reply">
            <span className="block text-[10px] tracking-widest text-cyan-300/70">{quoted.role === "user" ? "YOU" : "EXILE"}</span>
            <span className="line-clamp-2">{buildQuote(quoted.text)}</span>
          </button>
        )}
        {turn.replyTo && !quoted && <p className="mb-1.5 rounded-md border-l-2 border-slate-600 bg-slate-950/40 px-2 py-1 text-[12px] italic text-slate-400">Replying to a deleted message</p>}

        {editing ? (
          <div className="min-w-[14rem]">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
                else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveEdit(); }
              }}
              rows={Math.min(10, Math.max(2, draft.split("\n").length))}
              aria-label="Edit message"
              className="w-full resize-none rounded-md border border-cyan-400/40 bg-slate-950/80 p-2 text-sm text-cyan-50 outline-none focus:border-cyan-300"
            />
            <div className="mt-1.5 flex justify-end gap-2 text-xs">
              <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2.5 py-1 text-slate-300 hover:bg-slate-800">Cancel</button>
              <button type="button" onClick={saveEdit} className="rounded-md border border-cyan-400/50 bg-cyan-500/20 px-2.5 py-1 text-cyan-50 hover:bg-cyan-500/30">Save &amp; resend</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-400">Replies after this message will be replaced.</p>
          </div>
        ) : thinking ? (
          <div className="flex items-center gap-1.5 py-2" role="status" aria-label="EXILE is thinking" data-testid="thinking">
            <span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" />
          </div>
        ) : empty ? (
          <p className="py-1 text-sm italic text-slate-400" data-testid="no-response">{turn.text === "(no response)" ? "EXILE returned no response." : "No reply was received."}{canRegenerate ? " Use Regenerate to try again." : ""}</p>
        ) : (
          <div ref={bodyRef} className="chat-body space-y-1 text-[15px] leading-7 sm:text-base" data-testid="message-body">
            {parts.map((p, i) =>
              p.type === "code"
                ? <CodeBlock key={i} code={p.code} language={p.language} filename={p.filename} complete={p.complete && !streaming} />
                : p.text.trim() ? <p key={i} className="m-0 whitespace-pre-wrap"><Rich text={p.text.replace(/^\n+|\n+$/g, "")} /></p> : null,
            )}
          </div>
        )}

        {!editing && (generated.length > 0 || others.length > 0 || missingNames.length > 0) && (
          <div className="mt-1">
            {generated.map((f) => <ImageCard key={f.id} file={f} />)}
            {others.map((f) => <FileCard key={f.id} file={f} />)}
            {missingNames.map((n) => (
              <div key={n} className="my-1.5 max-w-sm rounded-lg border border-slate-600/50 bg-slate-950/60 px-2.5 py-1.5 text-[12px] text-slate-300" data-testid="file-missing">
                <span className="break-all">{n}</span>
                <span className="block text-[10px] text-slate-400">Preview and download are unavailable after the page was reloaded.</span>
              </div>
            ))}
          </div>
        )}

        <footer className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-slate-400">
          {turn.fallback && !isUser && <span className="rounded bg-amber-400/15 px-1 py-px text-amber-200">local answer</span>}
          {turn.edited && <span>edited</span>}
          <time dateTime={new Date(turn.at).toISOString()} title={new Date(turn.at).toLocaleString()}>{timeLabel(turn.at)}</time>
          {isUser && st && <span className="inline-flex items-center" title={st.label} aria-label={st.label} data-testid="status" data-status={status}>{st.icon}</span>}
        </footer>
      </article>
    </div>
  );
};

export default memo(MessageBubble);
