/**
 * Voice profiles: recorded samples + "active cloning" parameters applied to
 * browser speech synthesis (pitch / rate / timbre voice match).
 */

export interface VoiceProfile {
  id: string;
  name: string;
  /** base64 data URL of the recorded sample (optional) */
  sample?: string;
  voiceURI?: string;
  pitch: number;
  rate: number;
  createdAt: number;
}

const KEY = "exile.voice.profiles";
const ACTIVE = "exile.voice.active";

export function listVoiceProfiles(): VoiceProfile[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveVoiceProfile(p: VoiceProfile) {
  const all = listVoiceProfiles().filter((x) => x.id !== p.id);
  all.push(p);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteVoiceProfile(id: string) {
  localStorage.setItem(KEY, JSON.stringify(listVoiceProfiles().filter((p) => p.id !== id)));
  if (getActiveVoiceId() === id) localStorage.removeItem(ACTIVE);
}

export function setActiveVoice(id: string | null) {
  if (id) localStorage.setItem(ACTIVE, id);
  else localStorage.removeItem(ACTIVE);
}

export function getActiveVoiceId(): string | null {
  return localStorage.getItem(ACTIVE);
}

export function getActiveVoice(): VoiceProfile | null {
  const id = getActiveVoiceId();
  return listVoiceProfiles().find((p) => p.id === id) || null;
}

/** Speak using the active cloned profile if one is selected. */
export function speakWithProfile(text: string, onEnd?: () => void) {
  if (typeof speechSynthesis === "undefined") {
    onEnd?.();
    return;
  }
  const profile = getActiveVoice();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-GB";
  if (profile) {
    u.pitch = profile.pitch;
    u.rate = profile.rate;
    const match = speechSynthesis.getVoices().find((v) => v.voiceURI === profile.voiceURI);
    if (match) u.voice = match;
  }
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
