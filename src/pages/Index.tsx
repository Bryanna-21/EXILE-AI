import { useEffect, useRef, useState } from 'react';
import {
  MessageCircle, Camera, Search, Mic, Files, Share2, Wifi, WifiOff, Activity,
  MessageSquare, Phone, ShieldCheck, Home, Car, LayoutDashboard, Wand2, Film,
  FileText, BookOpen, Settings, Send, X, AudioLines, Grid3x3, KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import ChatSection from '@/components/ChatSection';
import CameraSection from '@/components/CameraSection';
import FilesSection from '@/components/FilesSection';
import ShareSection from '@/components/ShareSection';
import VoiceSection from '@/components/VoiceSection';
import ImageAnalysisSection from '@/components/ImageAnalysisSection';
import WhatsAppSection from '@/components/WhatsAppSection';
import CallsSection from '@/components/CallsSection';
import DashboardSection from '@/components/DashboardSection';
import SystemAccessSection from '@/components/SystemAccessSection';
import HouseSection from '@/components/HouseSection';
import CarControlSection from '@/components/CarControlSection';
import MissionControl from '@/components/MissionControl';
import ImageGenSection from '@/components/ImageGenSection';
import VideoStoryboardSection from '@/components/VideoStoryboardSection';
import DocumentSection from '@/components/DocumentSection';
import ResearchSection from '@/components/ResearchSection';
import VoiceStudio from '@/components/VoiceStudio';
import AppsSection from '@/components/AppsSection';
import ApiKeysSection from '@/components/ApiKeysSection';
import ArcReactor, { ReactorDock } from '@/components/ArcReactor';
import LockScreen from '@/components/LockScreen';
import { streamChat } from '@/lib/ai';
import { offlineRespond } from '@/lib/offlineExile';
import { speakWithProfile } from '@/lib/voiceProfiles';
import { micLevelMeter, speechLevelMeter, LevelMeter } from '@/lib/audioLevel';
import { routeToAgent } from '@/lib/agents';
import { memoryContext } from '@/lib/memory';
import { logReasoning } from '@/lib/reasoningLog';

const menuItems = [
  { id: 'api', icon: KeyRound, label: 'API' },
  { id: 'mission', icon: LayoutDashboard, label: 'Mission' },
  { id: 'chat', icon: MessageCircle, label: 'Console' },
  { id: 'research', icon: BookOpen, label: 'Research' },
  { id: 'generate', icon: Wand2, label: 'Render' },
  { id: 'cinema', icon: Film, label: 'Cinema' },
  { id: 'docs', icon: FileText, label: 'Docs' },
  { id: 'analysis', icon: Search, label: 'Vision' },
  { id: 'voicestudio', icon: AudioLines, label: 'Voice Lab' },
  { id: 'apps', icon: Grid3x3, label: 'Apps' },
  { id: 'voice', icon: Mic, label: 'Voice' },
  { id: 'dashboard', icon: Activity, label: 'Systems' },
  { id: 'system', icon: ShieldCheck, label: 'Access' },
  { id: 'house', icon: Home, label: 'House' },
  { id: 'car', icon: Car, label: 'Vehicle' },
  { id: 'whatsapp', icon: MessageSquare, label: 'WhatsApp' },
  { id: 'calls', icon: Phone, label: 'Calls' },
  { id: 'camera', icon: Camera, label: 'Optics' },
  { id: 'files', icon: Files, label: 'Vault' },
  { id: 'share', icon: Share2, label: 'Share' },
];

/** Panels that display large media → reactor docks bottom-right. */
const MEDIA_PANELS = new Set(['generate', 'cinema', 'camera', 'analysis', 'docs', 'files']);


const Index = () => {
  const [locked, setLocked] = useState(true);
  const [panel, setPanel] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [time, setTime] = useState(new Date());
  const [input, setInput] = useState('');
  const [reply, setReply] = useState('');
  const [state, setState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [level, setLevel] = useState(0);
  const recRef = useRef<any>(null);
  const meterRef = useRef<LevelMeter | null>(null);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      meterRef.current?.stop();
    };
  }, []);

  const stopMeter = () => {
    meterRef.current?.stop();
    meterRef.current = null;
    setLevel(0);
  };

  // Reactor docking: media panels → bottom-right, conversation → top-left, else center.
  const dock: ReactorDock = panel && MEDIA_PANELS.has(panel)
    ? 'bottom-right'
    : panel || reply
      ? 'top-left'
      : 'center';
  const reactorSize = dock === 'center' ? 320 : dock === 'bottom-right' ? 132 : 108;

  const dockStyle: Record<ReactorDock, React.CSSProperties> = {
    center: { top: '50%', left: '50%', transform: 'translate(-50%, -58%)' },
    'top-left': { top: 16, left: 16, transform: 'none' },
    'bottom-right': { top: 'calc(100% - 172px)', left: 'calc(100% - 172px)', transform: 'none' },
  };

  const renderPanel = (id: string) => {
    switch (id) {
      case 'api': return <ApiKeysSection />;
      case 'mission': return <MissionControl onOpenSection={setPanel} />;
      case 'chat': return <ChatSection />;
      case 'research': return <ResearchSection />;
      case 'generate': return <ImageGenSection />;
      case 'cinema': return <VideoStoryboardSection />;
      case 'docs': return <DocumentSection />;
      case 'dashboard': return <DashboardSection />;
      case 'system': return <SystemAccessSection />;
      case 'house': return <HouseSection />;
      case 'car': return <CarControlSection />;
      case 'whatsapp': return <WhatsAppSection />;
      case 'calls': return <CallsSection />;
      case 'camera': return <CameraSection />;
      case 'analysis': return <ImageAnalysisSection />;
      case 'voice': return <VoiceSection />;
      case 'voicestudio': return <VoiceStudio />;
      case 'apps': return <AppsSection />;
      case 'files': return <FilesSection />;
      case 'share': return <ShareSection />;
      default: return null;
    }
  };

  const say = (text: string) => {
    stopMeter();
    setState('speaking');
    meterRef.current = speechLevelMeter(setLevel);
    speakWithProfile(text, () => {
      stopMeter();
      setState('idle');
    });
  };

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setInput('');
    setReply('');
    stopMeter();
    setState('thinking');
    const agent = routeToAgent(text);
    logReasoning(agent.name, 'Received directive', text);

    const runOffline = () => {
      const r = offlineRespond(text);
      setReply(r.text);
      say(r.text);
    };

    if (!online) return runOffline();

    try {
      let full = '';
      await streamChat(
        'exile-chat',
        {
          messages: [
            ...(memoryContext() ? [{ role: 'system', content: memoryContext() }] : []),
            { role: 'system', content: `Active agent: ${agent.name}. ${agent.systemPrompt}` },
            { role: 'user', content: text },
          ],
        },
        (d) => {
          full += d;
          setReply(full);
        },
      );
      logReasoning(agent.name, 'Response delivered', full.slice(0, 120));
      if (full) say(full);
      else setState('idle');
    } catch {
      runOffline();
    }
  };

  const listen = async () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      stopMeter();
      ask(e.results[0][0].transcript);
    };
    rec.onend = () => {
      if (meterRef.current) stopMeter();
      setState((s) => (s === 'listening' ? 'idle' : s));
    };
    recRef.current = rec;
    setState('listening');
    try {
      meterRef.current = await micLevelMeter(setLevel);
    } catch {
      /* level spikes are optional */
    }
    rec.start();
  };

  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;

  return (
    <div className="min-h-screen bg-slate-950 text-cyan-100 relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 45%, rgba(56,189,248,0.14), transparent 55%), linear-gradient(rgba(34,211,238,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.05) 1px, transparent 1px)',
          backgroundSize: 'auto, 44px 44px, 44px 44px',
        }}
      />

      {/* top bar */}
      <header className="relative flex items-center justify-between px-5 pt-5">
        <div className="text-[10px] tracking-[0.4em] text-cyan-400/70 space-y-1 pl-28">
          <div className="flex items-center gap-1.5">
            {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3 text-amber-400" />}
            <span>{online ? 'DATA LINK ACTIVE' : 'LOCAL MODE'}</span>
          </div>
          <div className="font-mono text-cyan-400/50">{time.toLocaleTimeString()}</div>
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="w-11 h-11 rounded-full border border-cyan-500/40 bg-slate-900/50 flex items-center justify-center text-cyan-300 hover:bg-cyan-500/15 hover:shadow-[0_0_20px_rgba(34,211,238,0.35)] transition"
        >
          <Settings className="w-5 h-5" />
        </button>
      </header>

      {/* docking arc reactor */}
      <button
        onClick={listen}
        aria-label="Speak to EXILE"
        className="fixed z-50 transition-all duration-700 ease-in-out"
        style={dockStyle[dock]}
      >
        <ArcReactor size={reactorSize} state={state} amplitude={level} />
      </button>

      {/* core */}
      <main className="relative flex-1 flex flex-col items-center justify-end gap-8 px-6 pb-4">
        <div className="w-full max-w-3xl max-h-[52vh] min-h-[7rem] text-center overflow-y-auto px-2">
          {reply ? (
            <p className="text-base sm:text-lg leading-8 text-cyan-100/90 whitespace-pre-wrap text-left">{reply}</p>
          ) : (
            <p className="text-[10px] tracking-[0.4em] text-cyan-400/50">
              {state === 'listening' ? 'LISTENING…' : state === 'thinking' ? 'PROCESSING…' : 'EXILE STANDING BY'}
            </p>
          )}
        </div>
      </main>


      {/* type bar */}
      <footer className="relative px-5 pb-7">
        <form
          onSubmit={(e) => { e.preventDefault(); ask(input); }}
          className="mx-auto max-w-xl flex items-center gap-2 rounded-full border border-cyan-500/35 bg-slate-900/70 backdrop-blur px-4 py-2 shadow-[0_0_30px_rgba(34,211,238,0.15)]"
        >
          <button type="button" onClick={listen} className="text-cyan-300/80 hover:text-cyan-100" aria-label="Voice input">
            <Mic className="w-4 h-4" />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Speak or type a directive…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-cyan-500/40 text-cyan-50"
          />
          <Button type="submit" size="icon" variant="ghost" className="h-8 w-8 rounded-full text-cyan-300 hover:bg-cyan-500/15">
            <Send className="w-4 h-4" />
          </Button>
        </form>
        <p className="text-center text-[9px] tracking-[0.35em] text-cyan-500/40 mt-3">
          EXILE // YOUR AI · YOUR PC · YOUR RULES
        </p>
      </footer>

      {/* settings */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm bg-slate-950 border-cyan-500/30 text-cyan-100 overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-cyan-100 tracking-[0.3em] text-sm">SETTINGS</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-2 mt-6">
            {menuItems.map((item) => (
              <button
                key={item.id}
                onClick={() => { setPanel(item.id); setSettingsOpen(false); }}
                className="flex flex-col items-center gap-1 p-3 rounded-md border border-cyan-500/20 bg-slate-900/50 text-cyan-300/80 hover:bg-cyan-500/10 hover:text-cyan-100 transition"
              >
                <item.icon className="w-5 h-5" />
                <span className="text-[9px] tracking-widest uppercase">{item.label}</span>
              </button>
            ))}
          </div>
          <button
            onClick={() => { setSettingsOpen(false); setLocked(true); }}
            className="mt-6 w-full rounded-md border border-cyan-500/30 py-2 text-[10px] tracking-[0.3em] text-cyan-300/80 hover:bg-cyan-500/10"
          >
            LOCK EXILE
          </button>
        </SheetContent>
      </Sheet>

      {/* section overlay */}
      {panel && (
        <div className="fixed inset-0 z-40 bg-slate-950/95 backdrop-blur-sm overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] tracking-[0.35em] text-cyan-400/70 uppercase">
                {menuItems.find((m) => m.id === panel)?.label}
              </span>
              <button onClick={() => setPanel(null)} aria-label="Close" className="text-cyan-300 hover:text-cyan-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="rounded-lg border border-cyan-500/30 bg-slate-900/60 overflow-hidden">
              {renderPanel(panel)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Index;
