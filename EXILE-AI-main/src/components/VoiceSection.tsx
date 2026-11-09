import { useEffect, useRef, useState } from "react";
import { Mic, Square, Volume2, Download, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StateBanner } from "@/components/mission/ui";
import { toast } from "sonner";

const ctl = "border border-cyan-500/40 bg-transparent text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-40";

interface SpeechResultEvent { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }
interface Recognizer {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognizerCtor = new () => Recognizer;

const speechWindow = (typeof window !== "undefined" ? window : undefined) as unknown as
  | { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }
  | undefined;
const SR: RecognizerCtor | undefined = speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition;

/** Dictation (browser speech recognition), audio recording, and read-aloud. */
const VoiceSection = () => {
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<{ url: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognizer | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => () => {
    recRef.current?.abort();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    window.speechSynthesis?.cancel();
  }, []);

  const toggleDictation = () => {
    if (listening) { recRef.current?.stop(); return; }
    if (!SR) return;
    setError(null);
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let add = "";
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) add += e.results[i][0].transcript + " ";
      if (add) setTranscript((t) => (t ? t.replace(/\s*$/, " ") : "") + add);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission was denied." : e.error === "no-speech" ? "No speech was heard." : `Speech recognition stopped (${e.error}).`);
    r.onend = () => setListening(false);
    r.start();
    recRef.current = r;
    setListening(true);
  };

  const toggleRecording = async () => {
    if (recording) { mediaRef.current?.stop(); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunks.current = [];
      const m = new MediaRecorder(stream);
      m.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      m.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: m.mimeType || "audio/webm" });
        setClip((old) => { if (old) URL.revokeObjectURL(old.url); return { url: URL.createObjectURL(blob), name: `exile-recording-${Date.now()}.${blob.type.includes("mp4") ? "m4a" : "webm"}` }; });
        setRecording(false);
      };
      m.start();
      mediaRef.current = m;
      setRecording(true);
    } catch {
      setError("The microphone could not be opened. Check permission and that a microphone is connected.");
    }
  };

  const speak = () => {
    if (!transcript.trim() || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(transcript));
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(transcript); toast.success("Copied."); } catch { toast.error("Copy was blocked by the browser."); }
  };

  return (
    <div className="p-4 space-y-3 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Mic className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">VOICE</h2>
      </div>
      <p className="text-[11px] text-cyan-400/70">
        Dictate text, record audio, or have text read aloud. Dictation uses your browser's speech service, which may send audio to the browser vendor. Recordings stay on this computer until you download them.
      </p>
      {!SR && <StateBanner tone="info" title="Dictation not supported">This browser has no speech recognition. Recording and read-aloud still work.</StateBanner>}
      {error && <StateBanner tone="bad" title="Voice problem">{error}</StateBanner>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" className={ctl} disabled={!SR} onClick={toggleDictation} aria-pressed={listening}>
          {listening ? <><Square className="w-3.5 h-3.5 mr-1.5" /> Stop dictation</> : <><Mic className="w-3.5 h-3.5 mr-1.5" /> Dictate</>}
        </Button>
        <Button size="sm" variant="ghost" className={ctl} onClick={() => void toggleRecording()} aria-pressed={recording}>
          {recording ? <><Square className="w-3.5 h-3.5 mr-1.5" /> Stop recording</> : <><Mic className="w-3.5 h-3.5 mr-1.5" /> Record audio</>}
        </Button>
        <Button size="sm" variant="ghost" className={ctl} disabled={!transcript.trim()} onClick={speak}><Volume2 className="w-3.5 h-3.5 mr-1.5" /> Read aloud</Button>
        <Button size="sm" variant="ghost" className={ctl} disabled={!transcript.trim()} onClick={() => void copy()}><Copy className="w-3.5 h-3.5 mr-1.5" /> Copy</Button>
      </div>
      {(listening || recording) && <p role="status" className="text-[11px] text-red-300">{listening ? "Listening…" : "Recording…"}</p>}
      <Textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={5} placeholder="Dictated or typed text appears here" aria-label="Transcript" className="bg-slate-900 border-cyan-500/30 text-cyan-100 text-xs" />
      {clip && (
        <div className="flex items-center gap-2">
          <audio src={clip.url} controls className="h-8" aria-label="Recorded audio" />
          <a href={clip.url} download={clip.name} className="text-cyan-300 hover:text-cyan-100" aria-label="Download recording"><Download className="w-4 h-4" /></a>
        </div>
      )}
    </div>
  );
};

export default VoiceSection;
