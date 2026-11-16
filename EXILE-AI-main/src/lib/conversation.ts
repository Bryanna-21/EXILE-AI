/**
 * Conversation storage.
 * Chats are kept as *documents* (sessions): a session holds every turn of one
 * conversation and is saved as a whole, so closing the app never loses it.
 */

export interface TranscriptTurn {
  id: string;
  role: "user" | "exile";
  text: string;
  at: number;
  replyTo?: string;
  edited?: boolean;
  fallback?: boolean;
}

export type TurnExtras = Partial<Pick<TranscriptTurn, "replyTo" | "edited" | "fallback">>;

export interface ChatSession {
  id: string;
  title: string;
  turns: TranscriptTurn[];
  startedAt: number;
  updatedAt: number;
}

export interface VoiceClip {
  id: string;
  /** base64 data URL of the recorded command */
  audio?: string;
  transcript: string;
  at: number;
}

const S_KEY = "exile.sessions";
const A_KEY = "exile.session.active";
const V_KEY = "exile.voicelog";

function read<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function writeSessions(all: ChatSession[]) {
  localStorage.setItem(S_KEY, JSON.stringify(all.slice(-100)));
  window.dispatchEvent(new Event("exile:transcript"));
}

/* ---------------- sessions ---------------- */

export function listSessions(): ChatSession[] {
  return read<ChatSession>(S_KEY);
}

export function getActiveSessionId(): string | null {
  return localStorage.getItem(A_KEY);
}

function ensureSession(): ChatSession {
  const all = listSessions();
  const id = getActiveSessionId();
  const found = all.find((s) => s.id === id);
  if (found) return found;
  const fresh: ChatSession = {
    id: crypto.randomUUID(),
    title: "New conversation",
    turns: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(fresh);
  localStorage.setItem(A_KEY, fresh.id);
  writeSessions(all);
  return fresh;
}

/** Close the current conversation document; the next turn opens a new one. */
export function startNewSession() {
  localStorage.removeItem(A_KEY);
  window.dispatchEvent(new Event("exile:transcript"));
}

export function openSession(id: string) {
  if (listSessions().some((s) => s.id === id)) {
    localStorage.setItem(A_KEY, id);
    window.dispatchEvent(new Event("exile:transcript"));
  }
}

export function deleteSession(id: string) {
  writeSessions(listSessions().filter((s) => s.id !== id));
  if (getActiveSessionId() === id) localStorage.removeItem(A_KEY);
}

export function clearSessions() {
  localStorage.removeItem(S_KEY);
  localStorage.removeItem(A_KEY);
  window.dispatchEvent(new Event("exile:transcript"));
}

export function renameSession(id: string, title: string) {
  writeSessions(listSessions().map((s) => (s.id === id ? { ...s, title } : s)));
}

/** Plain-text export of a conversation document. */
export function sessionToText(s: ChatSession): string {
  return [
    `${s.title}`,
    `${new Date(s.startedAt).toLocaleString()}`,
    "",
    ...s.turns.map((t) => `${t.role === "user" ? "YOU" : "EXILE"}: ${t.text}`),
  ].join("\n");
}

/* ---------------- turns (within the active document) ---------------- */

export function listTurns(): TranscriptTurn[] {
  const id = getActiveSessionId();
  return listSessions().find((s) => s.id === id)?.turns ?? [];
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function addTurn(role: TranscriptTurn["role"], text: string, extras: TurnExtras = {}): TranscriptTurn {
  const session = ensureSession();
  const turn: TranscriptTurn = { id: crypto.randomUUID(), role, text, at: Date.now(), ...stripUndefined(extras) };
  const all = listSessions().map((s) =>
    s.id === session.id
      ? {
          ...s,
          turns: [...s.turns, turn],
          updatedAt: Date.now(),
          title:
            s.turns.length === 0 && role === "user"
              ? text.slice(0, 60) + (text.length > 60 ? "…" : "")
              : s.title,
        }
      : s,
  );
  writeSessions(all);
  return turn;
}

export function updateTurn(id: string, text: string) {
  const active = getActiveSessionId();
  writeSessions(
    listSessions().map((s) =>
      s.id === active
        ? { ...s, updatedAt: Date.now(), turns: s.turns.map((t) => (t.id === id ? { ...t, text } : t)) }
        : s,
    ),
  );
}

export function deleteTurn(id: string) {
  writeSessions(
    listSessions().map((s) => ({ ...s, turns: s.turns.filter((t) => t.id !== id) })),
  );
}


export function patchTurn(id: string, patch: Partial<Omit<TranscriptTurn, "id" | "role">>) {
  const active = getActiveSessionId();
  writeSessions(listSessions().map((s) =>
    s.id === active
      ? { ...s, updatedAt: Date.now(), turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
      : s,
  ));
}

export function truncateAfter(id: string): TranscriptTurn[] {
  const active = getActiveSessionId();
  let removed: TranscriptTurn[] = [];
  writeSessions(listSessions().map((s) => {
    if (s.id !== active) return s;
    const index = s.turns.findIndex((t) => t.id === id);
    if (index < 0) return s;
    removed = s.turns.slice(index + 1);
    return { ...s, updatedAt: Date.now(), turns: s.turns.slice(0, index + 1) };
  }));
  return removed;
}

export function restoreTurn(turn: TranscriptTurn, index: number) {
  const active = getActiveSessionId();
  writeSessions(listSessions().map((s) => {
    if (s.id !== active || s.turns.some((t) => t.id === turn.id)) return s;
    const turns = [...s.turns];
    turns.splice(Math.max(0, Math.min(index, turns.length)), 0, turn);
    return { ...s, updatedAt: Date.now(), turns };
  }));
}

/* ---------------- voice log ---------------- */

export function listVoiceClips(): VoiceClip[] {
  return read<VoiceClip>(V_KEY);
}

export function addVoiceClip(clip: VoiceClip) {
  const all = listVoiceClips();
  all.push(clip);
  localStorage.setItem(V_KEY, JSON.stringify(all.slice(-100)));
  window.dispatchEvent(new Event("exile:voicelog"));
}

export function deleteVoiceClip(id: string) {
  localStorage.setItem(V_KEY, JSON.stringify(listVoiceClips().filter((c) => c.id !== id)));
  window.dispatchEvent(new Event("exile:voicelog"));
}

export function clearVoiceClips() {
  localStorage.removeItem(V_KEY);
  window.dispatchEvent(new Event("exile:voicelog"));
}
