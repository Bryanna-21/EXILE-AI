// Offline rule-based Exile brain — works without internet.
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

  if (/\b(hi|hello|hey|exile|good (morning|evening|afternoon))\b/.test(q)) {
    return { text: pick(greetings) };
  }

  if (/\b(time|what time|clock)\b/.test(q)) {
    return { text: `The current time is ${new Date().toLocaleTimeString()}, Sir.` };
  }
  if (/\b(date|day|today)\b/.test(q)) {
    return { text: `Today is ${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.` };
  }

  if (/\bbattery\b/.test(q)) {
    return { text: "Querying device power systems…", action: { type: "battery" } };
  }

  if (/\b(open|show|go to)\s+(camera|photo)/.test(q)) return { text: "Opening camera array.", action: { type: "navigate", payload: "camera" } };
  if (/\b(open|show|go to)\s+files?/.test(q)) return { text: "Accessing file system.", action: { type: "navigate", payload: "files" } };
  if (/\b(open|show|go to)\s+share/.test(q)) return { text: "Opening share hub.", action: { type: "navigate", payload: "share" } };
  if (/\b(open|show|go to)\s+voice/.test(q)) return { text: "Voice interface engaged.", action: { type: "navigate", payload: "voice" } };
  if (/\b(open|show|grant)\s+(system|access|permission)/.test(q)) return { text: "Opening system access panel.", action: { type: "navigate", payload: "system" } };
  if (/\b(analyz|analys|scan).*(image|photo)/.test(q)) return { text: "Image analysis ready.", action: { type: "navigate", payload: "analysis" } };

  if (/^(search|google|look up|find)\b/.test(q)) {
    const term = q.replace(/^(search|google|look up|find)\s+(for\s+)?/, "");
    return {
      text: `I'd run a web search for "${term}", Sir, but we appear to be offline. I'll queue it for when connection returns.`,
      action: { type: "queue_search", payload: term },
    };
  }

  const math = q.match(/(?:what is|calculate|compute)\s+([0-9+\-*/().\s]+)/);
  if (math) {
    try {
      if (/^[0-9+\-*/().\s]+$/.test(math[1])) {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${math[1]})`)();
        return { text: `That would be ${result}, Sir.` };
      }
    } catch {}
  }

  if (/\b(what can you do|help|capabilit)/.test(q)) {
    return {
      text:
        "Offline I can tell time, do math, open sections of the app, and chat. With connection restored — or a local Ollama model — I gain full reasoning, web search, and image analysis.",
    };
  }

  if (/\b(thank|thanks)\b/.test(q)) return { text: "Always a pleasure, Sir." };
  if (/\b(bye|goodbye|exit)\b/.test(q)) return { text: "Standing by. Call when you need me." };

  return {
    text:
      "I'm in offline mode, Sir — limited reasoning. Reconnect, or start a local Ollama model, and I'll handle that in full.",
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

// ---------- Ollama local-model bridge ----------
// Used when the cloud API is unreachable. Operator must run `ollama serve`
// locally with CORS enabled, e.g.
//   OLLAMA_ORIGINS="*" ollama serve
// then `ollama pull llama3.2` (or any model).

const OLLAMA_URL_KEY = "exile.ollama.url";
const OLLAMA_MODEL_KEY = "exile.ollama.model";

export function getOllamaConfig() {
  return {
    url: localStorage.getItem(OLLAMA_URL_KEY) || "http://localhost:11434",
    model: localStorage.getItem(OLLAMA_MODEL_KEY) || "llama3.2",
  };
}

export function setOllamaConfig(url: string, model: string) {
  localStorage.setItem(OLLAMA_URL_KEY, url);
  localStorage.setItem(OLLAMA_MODEL_KEY, model);
}

export async function ollamaAvailable(): Promise<boolean> {
  try {
    const { url } = getOllamaConfig();
    const r = await fetch(`${url}/api/tags`, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

export interface OllamaMessage { role: "system" | "user" | "assistant"; content: string }

const EXILE_SYSTEM = `You are Exile, a sovereign personal cognitive assistant.
Never call yourself Jarvis or any other brand. Address the operator as Sir/Madam sparingly.
Tone: precise, composed, dry wit. Keep replies short unless asked.`;

export async function ollamaChatStream(
  messages: OllamaMessage[],
  onDelta: (chunk: string) => void,
): Promise<string> {
  const { url, model } = getOllamaConfig();
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: EXILE_SYSTEM }, ...messages],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line);
        const delta = json.message?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {}
    }
  }
  return full;
}
