/** Pure message operations for the chat screen: status, quoting, ordering, grouping. */

import type { TranscriptTurn } from "../conversation";

export type DeliveryStatus = "sending" | "sent" | "answered" | "answered-local";

const PLACEHOLDERS = new Set(["", "…", "...", "(no response)"]);

export const isPlaceholder = (text: string) => PLACEHOLDERS.has(text.trim());

/**
 * What can honestly be said about a message you sent:
 *  sending         – EXILE's reply has not started arriving yet
 *  sent            – saved, and EXILE is replying (or no reply exists)
 *  answered        – EXILE's reply to it is complete
 *  answered-local  – the reply was produced locally because the cloud model was unavailable
 */
export function deliveryStatus(turns: TranscriptTurn[], index: number, busy: boolean): DeliveryStatus {
  const next = turns[index + 1];
  const pending = busy && index + 1 >= turns.length - 1;
  if (!next || next.role !== "exile") return busy && index === turns.length - 1 ? "sending" : "sent";
  if (isPlaceholder(next.text)) return pending ? "sending" : "sent";
  if (pending) return "sent";
  return next.fallback ? "answered-local" : "answered";
}

export function isStreamingTurn(turns: TranscriptTurn[], index: number, busy: boolean): boolean {
  return busy && index === turns.length - 1 && turns[index]?.role === "exile";
}

export function previousUserTurn(turns: TranscriptTurn[], exileId: string): TranscriptTurn | null {
  const at = turns.findIndex((t) => t.id === exileId);
  for (let i = at - 1; i >= 0; i--) if (turns[i].role === "user") return turns[i];
  return null;
}

export function turnsAfter(turns: TranscriptTurn[], id: string): TranscriptTurn[] {
  const at = turns.findIndex((t) => t.id === id);
  return at < 0 ? [] : turns.slice(at + 1);
}

/** Short single-line preview of a message for reply bars and quoted replies. */
export function buildQuote(text: string, max = 140): string {
  const flat = text
    .replace(/\n\n\[Attached files: [^\]]*\]\s*$/, "")
    .replace(/```[\s\S]*?(```|$)/g, " [code] ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "[attachment]";
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Context line telling the model which earlier message a turn is replying to ("" when none). */
export function replyPrefix(turn: TranscriptTurn, turns: TranscriptTurn[]): string {
  const target = turn.replyTo ? turns.find((t) => t.id === turn.replyTo) : undefined;
  if (!target) return "";
  const who = target.role === "exile" ? "your earlier message" : "their own earlier message";
  return `[The user is replying to ${who}: "${buildQuote(target.text, 300)}"]\n`;
}

/** Text sent to the model for a past turn, including what it was replying to. */
export function withReplyContext(turn: TranscriptTurn, turns: TranscriptTurn[]): string {
  return replyPrefix(turn, turns) + turn.text;
}

export interface DayGroup {
  key: string;
  label: string;
  startIndex: number;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Indexes where a new calendar day starts, with a "Today / Yesterday / date" label. */
export function dayGroups(turns: TranscriptTurn[], now = new Date(), locale?: string): DayGroup[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: DayGroup[] = [];
  let last = "";
  turns.forEach((t, i) => {
    const d = new Date(t.at);
    const key = dayKey(d);
    if (key === last) return;
    last = key;
    groups.push({
      key,
      startIndex: i,
      label:
        key === today ? "Today"
        : key === yesterday ? "Yesterday"
        : d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }),
    });
  });
  return groups;
}
