import { useState } from "react";
import { Eye, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { streamChat, fileToDataUrl } from "@/lib/ai";
import { logReasoning } from "@/lib/reasoningLog";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

/** Vision: sends the chosen image to the configured model and shows its real answer. */
const ImageAnalysisSection = () => {
  const [image, setImage] = useState<{ name: string; mime: string; dataUrl: string } | null>(null);
  const [prompt, setPrompt] = useState("Describe this image. Read any visible text exactly and say if something is unclear.");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED.includes(file.type)) return toast.error("Choose a PNG, JPEG or WebP image.");
    if (file.size > MAX_BYTES) return toast.error("That image is larger than 8 MB.");
    try {
      setImage({ name: file.name, mime: file.type, dataUrl: await fileToDataUrl(file) });
      setOutput("");
    } catch {
      toast.error("Could not read that image.");
    }
  };

  const run = async () => {
    if (!image || busy) return;
    setBusy(true);
    setOutput("");
    logReasoning("Vision", "analyzing", image.name, 0.9);
    try {
      await streamChat(
        "exile-analyze",
        { prompt: prompt.trim() || "Describe this image.", attachments: [{ kind: "image", mime: image.mime, name: image.name, dataUrl: image.dataUrl }] },
        (d) => setOutput((o) => o + d),
      );
    } catch (e: unknown) {
      toast.error((e as { message?: string })?.message || "Analysis failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Eye className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">VISION</h2>
      </div>
      <p className="text-[11px] text-cyan-400/70">
        Sends your image to the configured AI model and shows its answer. It needs a provider that can read images; the answer is the model's, not a guaranteed fact.
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer bg-cyan-500/15 border border-cyan-400/40 px-3 py-2 rounded text-xs tracking-widest hover:bg-cyan-500/25">
          <Upload className="w-4 h-4" /> CHOOSE IMAGE
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="Choose image" onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {image && <span className="text-[11px] text-cyan-300/80 truncate max-w-xs">{image.name}</span>}
      </div>
      {image && <img src={image.dataUrl} alt="Selected for analysis" className="max-h-56 rounded border border-cyan-500/30" />}
      <div className="flex gap-2">
        <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="What to look for" className="bg-slate-900 border-cyan-500/30 text-cyan-100" />
        <Button onClick={run} disabled={!image || busy} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100 hover:bg-cyan-500/30">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Analyze"}
        </Button>
      </div>
      {output && <pre className="whitespace-pre-wrap text-xs bg-slate-900/60 border border-cyan-500/20 rounded p-3 max-h-72 overflow-auto" aria-label="Analysis result">{output}</pre>}
    </div>
  );
};

export default ImageAnalysisSection;
