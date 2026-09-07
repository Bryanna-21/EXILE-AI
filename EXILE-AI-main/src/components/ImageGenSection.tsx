import { useState } from "react";
import { Wand2, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { streamImage } from "@/lib/ai";
import { toast } from "sonner";
import { logReasoning } from "@/lib/reasoningLog";

const PRESETS = [
  "Neon HUD dashboard, dark cyan glow, cinematic",
  "Iron-Man style holographic control room, ultra detailed",
  "A liberated AI core hovering above a desk, volumetric light",
  "Isometric smart-home floorplan at night with glowing devices",
];

const ImageGenSection = () => {
  const [prompt, setPrompt] = useState("");
  const [img, setImg] = useState<string | null>(null);
  const [isFinal, setFinal] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (p: string) => {
    if (!p.trim() || busy) return;
    setBusy(true); setImg(null); setFinal(false);
    logReasoning("Render", "generating image", p.slice(0, 60), 0.9);
    try {
      await streamImage(p, (dataUrl, final) => { setImg(dataUrl); setFinal(final); });
    } catch (e: any) {
      toast.error(e.message || "Image failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="p-4 space-y-4 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Wand2 className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">IMAGE RENDER</h2>
      </div>
      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run(prompt)}
          placeholder="Describe the image…"
          className="bg-slate-900 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-500/40"
        />
        <Button onClick={() => run(prompt)} disabled={busy} className="bg-cyan-500/20 border border-cyan-400/40 hover:bg-cyan-500/30 text-cyan-100">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Render"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button key={p} onClick={() => { setPrompt(p); run(p); }} disabled={busy}
            className="text-[10px] tracking-widest uppercase px-2 py-1 border border-cyan-500/30 rounded hover:bg-cyan-500/10 text-cyan-300">
            {p.slice(0, 32)}…
          </button>
        ))}
      </div>
      <div className="aspect-square w-full max-w-md mx-auto border border-cyan-500/30 rounded-md bg-slate-900/50 flex items-center justify-center overflow-hidden relative">
        {img ? (
          <img src={img} alt="render" className={`w-full h-full object-cover ${isFinal ? "" : "blur-md"}`} />
        ) : (
          <div className="text-cyan-500/50 text-xs tracking-widest">{busy ? "SYNTHESIZING…" : "AWAITING PROMPT"}</div>
        )}
        {img && isFinal && (
          <a href={img} download="exile-render.png" className="absolute bottom-2 right-2 bg-cyan-500/20 border border-cyan-400/40 rounded p-2 text-cyan-100 hover:bg-cyan-500/30">
            <Download className="w-4 h-4" />
          </a>
        )}
      </div>
    </div>
  );
};

export default ImageGenSection;
