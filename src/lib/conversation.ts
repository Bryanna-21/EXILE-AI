/**
 * Persistent conversation transcript + recorded voice command log.
 * Everything is stored locally so nothing is ever lost between sessions.
 */

export interface TranscriptTurn {
  id: string;
  role: "user" | "exile";
  text: string;
  at: number;
}

export interface VoiceClip {
  id: string;
  /** base64 data URL of the recorded command */
  audio?: string;
  transcript: string;
  at: number;
}

const T_KEY = "exile.transcript";
const V_KEY = "exile.voicelog";

function read<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

/* ---------------- transcript ---------------- */

export function listTurns(): TranscriptTurn[] {
  return read<TranscriptTurn>(T_KEY);
}

export function addTurn(role: TranscriptTurn["role"], text: string): TranscriptTurn {
  const turn: TranscriptTurn = { id: crypto.randomUUID(), role, text, at: Date.now() };
  const all = listTurns();
  all.push(turn);
  localStorage.setItem(T_KEY, JSON.stringify(all.slice(-500)));
  window.dispatchEvent(new Event("exile:transcript"));
  return turn;
}

export function updateTurn(id: string, text: string) {
  const all = listTurns().map((t) => (t.id === id ? { ...t, text } : t));
  localStorage.setItem(T_KEY, JSON.stringify(all));
  window.dispatchEvent(new Event("exile:transcript"));
}

export function deleteTurn(id: string) {
  localStorage.setItem(T_KEY, JSON.stringify(listTurns().filter((t) => t.id !== id)));
  window.dispatchEvent(new Event("exile:transcript"));
}

export function clearTranscript() {
  localStorage.removeItem(T_KEY);
  window.dispatchEvent(new Event("exile:transcript"));
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
