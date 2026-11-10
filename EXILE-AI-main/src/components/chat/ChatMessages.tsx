import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { TranscriptTurn } from "@/lib/conversation";
import { useSyncExternalStore } from "react";
import { chatMedia } from "@/lib/chat/mediaStore";
import { dayGroups, deliveryStatus, isPlaceholder, isStreamingTurn } from "@/lib/chat/ops";
import MessageBubble, { type MessageHandlers } from "./MessageBubble";
import "./chat.css";

export interface ChatMessagesProps extends Omit<MessageHandlers, "onJumpTo"> {
  turns: TranscriptTurn[];
  /** True from the moment a message is sent until EXILE's reply is complete. */
  busy: boolean;
  /** Shown when there are no messages (e.g. "EXILE STANDING BY"). */
  emptyLabel: string;
  /** Shown under the messages while listening or speaking (not while thinking). */
  statusLabel?: string;
}

const NEAR_BOTTOM = 96;
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Scrollable conversation: day separators, bubbles, thinking/streaming states, and follow-the-bottom scrolling. */
const ChatMessages = ({ turns, busy, emptyLabel, statusLabel, ...handlers }: ChatMessagesProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const media = useSyncExternalStore(chatMedia.subscribe, chatMedia.getSnapshot);

  const groups = useMemo(() => new Map(dayGroups(turns).map((g) => [g.startIndex, g.label])), [turns]);
  const byId = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);

  const toBottom = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced() ? "smooth" : "auto" });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    stick.current = near;
    setAway(!near);
  };

  const last = turns[turns.length - 1];
  const signature = `${turns.length}:${last?.id}:${last?.text.length}`;
  useLayoutEffect(() => { if (stick.current) toBottom(false); }, [signature, toBottom]);
  // A new message from the user always brings the view back to the bottom.
  useEffect(() => { if (last?.role === "user") { stick.current = true; toBottom(true); } }, [last?.id, last?.role, toBottom]);

  const jumpTo = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    el.animate?.([{ outline: "2px solid rgba(103,232,249,0.9)" }, { outline: "2px solid transparent" }], { duration: 1200 });
  };

  return (
    <div className="relative flex min-h-0 w-full max-w-4xl flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="chat-scroll min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-2 py-1"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        data-testid="chat-log"
      >
        {turns.length === 0 ? (
          <p className="text-center text-[10px] tracking-[0.4em] text-cyan-400/50">{emptyLabel}</p>
        ) : (
          turns.map((t, i) => {
            const streaming = isStreamingTurn(turns, i, busy);
            const thinking = streaming && isPlaceholder(t.text);
            return (
              <div key={t.id}>
                {groups.has(i) && (
                  <div className="my-2 flex justify-center"><span className="rounded-full bg-slate-900/80 px-3 py-0.5 text-[10px] tracking-widest text-cyan-300/60">{groups.get(i)}</span></div>
                )}
                <MessageBubble
                  turn={t}
                  status={t.role === "user" ? deliveryStatus(turns, i, busy) : null}
                  busy={busy}
                  streaming={streaming && !thinking}
                  thinking={thinking}
                  files={media.get(t.id) ?? []}
                  quoted={t.replyTo ? byId.get(t.replyTo) ?? null : null}
                  canRegenerate={t.role === "exile" && i === turns.length - 1 && turns.slice(0, i).some((x) => x.role === "user")}
                  {...handlers}
                  onJumpTo={jumpTo}
                />
              </div>
            );
          })
        )}
        {turns.length > 0 && statusLabel && <p className="text-center text-[10px] tracking-[0.4em] text-cyan-400/50">{statusLabel}</p>}
      </div>
      {away && turns.length > 0 && (
        <button
          type="button"
          onClick={() => { stick.current = true; toBottom(true); setAway(false); }}
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-cyan-400/40 bg-slate-950/90 px-3 py-1 text-[11px] text-cyan-100 shadow-lg hover:bg-cyan-500/20"
          aria-label="Scroll to latest message"
        >
          <ArrowDown className="h-3.5 w-3.5" /> Latest
        </button>
      )}
    </div>
  );
};

export default ChatMessages;
