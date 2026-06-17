import { useEffect, useState } from 'react';
import { MessageCircle, Camera, Search, Image as ImageIcon, Mic, Files, Share2, Cpu, Wifi, WifiOff, Activity, MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import ChatSection from '@/components/ChatSection';
import CameraSection from '@/components/CameraSection';
import FilesSection from '@/components/FilesSection';
import ShareSection from '@/components/ShareSection';
import VoiceSection from '@/components/VoiceSection';
import ImageAnalysisSection from '@/components/ImageAnalysisSection';
import WhatsAppSection from '@/components/WhatsAppSection';
import CallsSection from '@/components/CallsSection';
import DashboardSection from '@/components/DashboardSection';

const Index = () => {
  const [activeSection, setActiveSection] = useState('chat');
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [time, setTime] = useState(new Date());

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
    };
  }, []);

  const menuItems = [
    { id: 'chat', icon: MessageCircle, label: 'Console' },
    { id: 'dashboard', icon: Activity, label: 'Systems' },
    { id: 'whatsapp', icon: MessageSquare, label: 'WhatsApp' },
    { id: 'calls', icon: Phone, label: 'Calls' },
    { id: 'camera', icon: Camera, label: 'Optics' },
    { id: 'analysis', icon: Search, label: 'Analyze' },
    { id: 'voice', icon: Mic, label: 'Voice' },
    { id: 'files', icon: Files, label: 'Vault' },
    { id: 'share', icon: Share2, label: 'Share' },
    { id: 'generate', icon: ImageIcon, label: 'Render' },
  ];

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'chat': return <ChatSection />;
      case 'dashboard': return <DashboardSection />;
      case 'whatsapp': return <WhatsAppSection />;
      case 'calls': return <CallsSection />;
      case 'camera': return <CameraSection />;
      case 'analysis': return <ImageAnalysisSection />;
      case 'voice': return <VoiceSection />;
      case 'files': return <FilesSection />;
      case 'share': return <ShareSection />;
      default: return <ChatSection />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-cyan-100 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 10%, rgba(34,211,238,0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(59,130,246,0.15), transparent 40%), linear-gradient(rgba(34,211,238,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.06) 1px, transparent 1px)',
          backgroundSize: 'auto, auto, 40px 40px, 40px 40px',
        }}
      />

      <div className="relative">
        <div className="px-4 pt-6 pb-4 max-w-3xl mx-auto">
          <div className="flex items-center justify-between border-b border-cyan-500/30 pb-3">
            <div className="flex items-center gap-3">
              <div className="relative w-10 h-10 rounded-full border-2 border-cyan-400/60 flex items-center justify-center">
                <Cpu className="w-5 h-5 text-cyan-300" />
                <span className="absolute inset-0 rounded-full border border-cyan-400/30 animate-ping" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-[0.3em] text-cyan-100">EXILE</h1>
                <p className="text-[10px] tracking-widest text-cyan-400/70">COGNITIVE OS v5 · 15 SYSTEMS ONLINE</p>
              </div>
            </div>
            <div className="text-right text-xs space-y-0.5">
              <div className={`flex items-center justify-end gap-1 ${online ? 'text-cyan-300' : 'text-amber-400'}`}>
                {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                <span className="tracking-widest">{online ? 'DATA LINK ACTIVE' : 'LOCAL MODE'}</span>
              </div>
              <div className="text-cyan-400/70 tracking-widest font-mono">
                {time.toLocaleTimeString()}
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 mb-4 max-w-3xl mx-auto">
          <div className="grid grid-cols-4 gap-2">
            {menuItems.map((item) => {
              const active = activeSection === item.id;
              return (
                <Button
                  key={item.id}
                  variant="ghost"
                  onClick={() => setActiveSection(item.id)}
                  className={`flex flex-col items-center gap-1 p-3 h-auto rounded-md border transition-all ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.25)]'
                      : 'bg-slate-900/40 border-cyan-500/20 text-cyan-300/70 hover:bg-cyan-500/10 hover:text-cyan-100'
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="text-[10px] tracking-widest uppercase">{item.label}</span>
                </Button>
              );
            })}
          </div>
        </div>

        <div className="px-4 pb-10 max-w-3xl mx-auto">
          <Card className="bg-slate-900/60 backdrop-blur-sm border border-cyan-500/30 shadow-[0_0_40px_rgba(34,211,238,0.15)] overflow-hidden">
            <CardContent className="p-0">{renderActiveSection()}</CardContent>
          </Card>
          <p className="text-center text-[10px] tracking-[0.3em] text-cyan-500/50 mt-4">
            STARK INDUSTRIES // SECURE CHANNEL
          </p>
        </div>
      </div>
    </div>
  );
};

export default Index;
