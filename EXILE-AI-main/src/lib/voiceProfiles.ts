/**
 * Voice profiles: recorded samples + "active cloning" parameters applied to
 * browser speech synthesis (pitch / rate / timbre voice match).
 */

import { isVenomModeEnabled } from "@/lib/venomMode";

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

/** Speak with the active profile, or use the desktop Venom-inspired audio path. */

import { cancelVenomAudio, speakVenomAudio } from "@/lib/venomAudio";

/**
 * Prepare assistant text for speech without reading source code or URLs aloud.
 * The original message remains unchanged in the chat.
 */
export function prepareSpeechText(input: string): string {
  let text = String(input ?? "").replace(/\r\n?/g, "\n");
  let removedCode = false;

  // Remove complete or still-streaming fenced code blocks.
  text = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, () => {
    removedCode = true;
    return " ";
  });

  // Replace inline code rather than spelling its punctuation aloud.
  text = text.replace(/`[^`\n]+`/g, () => {
    removedCode = true;
    return " code snippet ";
  });

  // Preserve readable link labels, but never speak the destination.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, " ");
  text = text.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " email address ");

  // Ignore markup and common Markdown decoration while keeping the words.
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, " ");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/__(.*?)__/g, "$1");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/\*(.*?)\*/g, "$1");
  text = text.replace(/\$(\$)?[\s\S]*?\$(?:\$)?/g, " mathematical expression ");

  // If the remaining response is mostly raw source, don't read it line by line.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const codeLine = /(?:^\s*(?:import|export|const|let|var|function|class|return|if|for|while|def|from|print|#include|SELECT|CREATE TABLE)\b|[{};=<>]{2,}|=>|^\s*[$#]\s)/i;
  const codeLines = lines.filter((line) => codeLine.test(line)).length;
  const proseLines = lines.filter(
    (line) => /[.!?]$/.test(line) && /[A-Za-z]{3,}/.test(line),
  ).length;

  if (
    lines.length > 0 &&
    codeLines / lines.length >= 0.6 &&
    proseLines === 0
  ) {
    return "The code is available in the written response.";
  }

  text = text.replace(/\s+/g, " ").trim();

  if (!text) {
    return removedCode ? "The code is available in the written response." : "";
  }

  if (removedCode && !/code is available in the written response/i.test(text)) {
    text += " The code is available in the written response.";
  }

  return text;
}

let speechRequestId = 0;

export function speakWithProfile(text: string, onEnd?: () => void) {
  const requestId = ++speechRequestId;
  cancelVenomAudio();
  text = prepareSpeechText(text);
  if (!text) {
    onEnd?.();
    return;
  }

  if (typeof speechSynthesis === "undefined") {
    onEnd?.();
    return;
  }

  const profile = getActiveVoice();
  const venomMode = isVenomModeEnabled();

  const fallbackToBrowserSpeech = () => {
    if (requestId !== speechRequestId) return;

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.pitch = venomMode
      ? Math.min(profile?.pitch ?? 0.72, 0.8)
      : (profile?.pitch ?? 1);
    u.rate = venomMode
      ? Math.min(profile?.rate ?? 0.88, 0.92)
      : (profile?.rate ?? 1);

    if (profile?.voiceURI) {
      const match = speechSynthesis.getVoices().find(
        (v) => v.voiceURI === profile.voiceURI,
      );
      if (match) u.voice = match;
    }

    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      onEnd?.();
    };

    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  speechSynthesis.cancel();

  if (!venomMode || !window.exileDesktop?.synthesizeVenom) {
    fallbackToBrowserSpeech();
    return;
  }

  void window.exileDesktop.synthesizeVenom(text).then(async (audioData) => {
    if (requestId !== speechRequestId) return;

    if (audioData) {
      const played = await speakVenomAudio(audioData, () => {
        if (requestId === speechRequestId) onEnd?.();
      });
      if (played || requestId !== speechRequestId) return;
    }

    fallbackToBrowserSpeech();
  }).catch(() => {
    fallbackToBrowserSpeech();
  });
}
