import { useEffect, useState } from "react";
import { Plus, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NativeAppsPanel from "@/components/apps/NativeAppsPanel";
import { ExileApp, listApps, addApp, removeApp, launchApp, linkProblem } from "@/lib/appRegistry";

const AppsSection = () => {
  const [apps, setApps] = useState<ExileApp[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [emoji, setEmoji] = useState("🛰");

  useEffect(() => setApps(listApps()), []);

  const add = () => {
    if (!name.trim() || !url.trim()) return toast.error("Name and link are required.");
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    const problem = linkProblem(normalized);
    if (problem) return toast.error(problem);
    addApp({ name: name.trim(), url: normalized, emoji: emoji || "🛰" });
    setApps(listApps());
    setName(""); setUrl("");
    toast.success("App linked to EXILE.");
  };

  return (
    <div className="p-4 space-y-4 text-cyan-100">
      <div>
        <p className="text-xs text-cyan-400/60 mt-1">
          Desktop apps are programs on this computer and open in their own windows. Web links open in your browser.
        </p>
      </div>
      <Tabs defaultValue="desktop">
        <TabsList className="bg-slate-900/60 border border-cyan-500/20">
          <TabsTrigger value="desktop">Desktop apps</TabsTrigger>
          <TabsTrigger value="web">Web links</TabsTrigger>
        </TabsList>
        <TabsContent value="desktop" className="mt-3"><NativeAppsPanel /></TabsContent>
        <TabsContent value="web" className="mt-3 space-y-5">

      <div className="rounded-md border border-cyan-500/25 bg-slate-900/60 p-4 space-y-3">
        <div className="flex gap-2">
          <Input
            value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 2))}
            className="w-16 text-center bg-slate-950 border-cyan-500/30 text-cyan-100"
          />
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="App name"
            className="flex-1 bg-slate-950 border-cyan-500/30 text-cyan-100"
          />
        </div>
        <Input
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="Link or protocol (e.g. spotify: or notion.so)"
          className="bg-slate-950 border-cyan-500/30 text-cyan-100"
        />
        <Button onClick={add} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100">
          <Plus className="w-4 h-4 mr-2" /> Add app
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {apps.map((a) => (
          <div
            key={a.id}
            className="relative rounded-md border border-cyan-500/20 bg-slate-900/50 p-3 text-center"
          >
            <button onClick={() => { const r = launchApp(a); if (!r.ok) toast.error(r.message ?? "Could not open this link."); }} className="w-full">
              <div className="text-2xl">{a.emoji}</div>
              <div className="text-[10px] mt-1 truncate text-cyan-200">{a.name}</div>
              <ExternalLink className="w-3 h-3 mx-auto mt-1 text-cyan-400/50" />
            </button>
            <button
              onClick={() => { removeApp(a.id); setApps(listApps()); }}
              aria-label={`Remove ${a.name}`}
              className="absolute top-1 right-1 text-red-300/70 hover:text-red-200"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        {apps.length === 0 && (
          <p className="col-span-3 text-xs text-cyan-400/50">No apps added yet.</p>
        )}
      </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AppsSection;
