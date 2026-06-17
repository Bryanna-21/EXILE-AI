// Offline rule-based Jarvis brain — works without internet.
// Handles common commands locally so the assistant is always responsive.

export interface OfflineResponse {
  text: string;
  action?: { type: string; payload?: any };
}

const greetings = [
  "At your service, Sir.",
  "Online and standing by.",
  "Good to hear from you. How may I assist?",
  "Ready when you are.",
];

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

export function offlineRespond(input: string): OfflineResponse {
  const q = input.toLowerCase().trim();

  if (!q) return { text: "I'm listening, Sir." };

  // Greetings
  if (/\b(hi|hello|hey|jarvis|exile|good (morning|evening|afternoon))\b/.test(q)) {
    return { text: pick(greetings) };
  }

  // Time / date
  if (/\b(time|what time|clock)\b/.test(q)) {
    return { text: `The current time is ${new Date().toLocaleTimeString()}, Sir.` };
  }
  if (/\b(date|day|today)\b/.test(q)) {
    return { text: `Today is ${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.` };
  }

  // Battery
  if (/\bbattery\b/.test(q)) {
    return { text: "Querying device power systems…", action: { type: "battery" } };
  }

  // Navigation
  if (/\b(open|show|go to)\s+(camera|photo)/.test(q)) return { text: "Opening camera array.", action: { type: "navigate", payload: "camera" } };
  if (/\b(open|show|go to)\s+files?/.test(q)) return { text: "Accessing file system.", action: { type: "navigate", payload: "files" } };
  if (/\b(open|show|go to)\s+share/.test(q)) return { text: "Opening share hub.", action: { type: "navigate", payload: "share" } };
  if (/\b(open|show|go to)\s+voice/.test(q)) return { text: "Voice interface engaged.", action: { type: "navigate", payload: "voice" } };
  if (/\b(analyz|analys|scan).*(image|photo)/.test(q)) return { text: "Image analysis ready.", action: { type: "navigate", payload: "analysis" } };

  // Search intent
  if (/^(search|google|look up|find)\b/.test(q)) {
    const term = q.replace(/^(search|google|look up|find)\s+(for\s+)?/, "");
    return {
      text: `I'd run a web search for "${term}", Sir, but we appear to be offline. I'll queue it for when connection returns.`,
      action: { type: "queue_search", payload: term },
    };
  }

  // Math
  const math = q.match(/(?:what is|calculate|compute)\s+([0-9+\-*/().\s]+)/);
  if (math) {
    try {
      // Safe eval: only digits and operators
      if (/^[0-9+\-*/().\s]+$/.test(math[1])) {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${math[1]})`)();
        return { text: `That would be ${result}, Sir.` };
      }
    } catch {}
  }

  // Capabilities
  if (/\b(what can you do|help|capabilit)/.test(q)) {
    return {
      text:
        "Offline I can tell time, do math, open sections of the app, and chat. With connection restored I gain full reasoning, web search, and image analysis. Just say the word.",
    };
  }

  if (/\b(thank|thanks)\b/.test(q)) return { text: "Always a pleasure, Sir." };
  if (/\b(bye|goodbye|exit)\b/.test(q)) return { text: "Standing by. Call when you need me." };

  return {
    text:
      "I'm operating in offline mode, Sir, so my reasoning is limited. Reconnect to data and I'll handle that in full.",
  };
}

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const british =
      voices.find((v) => /en-GB/i.test(v.lang) && /male/i.test(v.name)) ||
      voices.find((v) => /en-GB/i.test(v.lang)) ||
      voices.find((v) => /Daniel|Google UK English Male/i.test(v.name));
    if (british) u.voice = british;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {}
}
