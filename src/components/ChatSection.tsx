import { useEffect, useRef, useState } from "react";
import { Bot, User, Send, Mic, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { offlineRespond, speak } from "@/lib/offlineJarvis";
import { toast } from "sonner";

interface Message {
  id: string;
  content: string;
  sender: "user" | "ai";
  timestamp: Date;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

const ChatSection = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      content:
        "J.A.R.V.I.S. online. All systems nominal. Whether we have data or not, I'm at your service, Sir. How may I assist?",
      sender: "ai",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const addMessage = (content: string, sender: "user" | "ai") => {
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), content, sender, timestamp: new Date() },
    ]);
  };

  const handleOffline = (userText: string) => {
    const r = offlineRespond(userText);
    addMessage(r.text, "ai");
    if (voiceOn) speak(r.text);
  };

  const handleOnline = async (userText: string, history: Message[]) => {
    setLoading(true);
    const aiId = crypto.randomUUID();
    setMessages((m) => [...m, { id: aiId, content: "", sender: "ai", timestamp: new Date() }]);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/jarvis-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          messages: [
            ...history.map((m) => ({
              role: m.sender === "user" ? "user" : "assistant",
              content: m.content,
            })),
            { role: "user", content: userText },
          ],
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Connection failed" }));
        if (res.status === 429) toast.error("Rate limit — try again in a moment.");
        else if (res.status === 402) toast.error("AI credits depleted.");
        else toast.error(err.error || "AI request failed");
        // fallback to offline
        const r = offlineRespond(userText);
        setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: r.text } : x)));
        if (voiceOn) speak(r.text);
        return;
      }

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
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: full } : x)));
            }
          } catch {}
        }
      }
      if (voiceOn && full) speak(full);
    } catch (e) {
      const r = offlineRespond(userText);
      setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: r.text } : x)));
      if (voiceOn) speak(r.text);
    } finally {
      setLoading(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    addMessage(text, "user");
    if (online) handleOnline(text, messages);
    else handleOffline(text);
  };

  const startMic = () => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error("Voice input not supported in this browser.");
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => setInput(e.results[0][0].transcript);
    rec.onerror = () => toast.error("Microphone error");
    rec.start();
  };

  return (
    <div className="h-[28rem] flex flex-col bg-slate-950 text-cyan-100">
      <div className="p-4 border-b border-cyan-500/30 bg-gradient-to-r from-slate-900 via-slate-950 to-slate-900 flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2 tracking-widest">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          J.A.R.V.I.S.
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <span className={`flex items-center gap-1 ${online ? "text-cyan-300" : "text-amber-400"}`}>
            {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {online ? "ONLINE" : "OFFLINE"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-cyan-300 hover:bg-cyan-500/10"
            onClick={() => setVoiceOn((v) => !v)}
          >
            {voiceOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef as any}>
        <div className="p-4 space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex gap-2 ${m.sender === "user" ? "justify-end" : "justify-start"}`}
            >
              {m.sender === "ai" && (
                <div className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3.5 h-3.5 text-cyan-300" />
                </div>
              )}
              <div
                className={`max-w-[80%] px-3 py-2 rounded-md text-sm leading-relaxed border ${
                  m.sender === "user"
                    ? "bg-cyan-500/15 border-cyan-400/40 text-cyan-50"
                    : "bg-slate-900/80 border-cyan-500/20 text-cyan-100"
                }`}
              >
                {m.content || <span className="opacity-60">…</span>}
              </div>
              {m.sender === "user" && (
                <div className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center flex-shrink-0">
                  <User className="w-3.5 h-3.5 text-cyan-300" />
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-cyan-500/30 bg-slate-900/80 flex gap-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={startMic}
          className="text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/30"
        >
          <Mic className="w-4 h-4" />
        </Button>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={online ? "Speak freely, Sir…" : "Offline mode — local commands only"}
          className="flex-1 bg-slate-950 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-500/50 focus-visible:ring-cyan-500/40"
        />
        <Button
          onClick={send}
          disabled={loading}
          className="bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

export default ChatSection;
