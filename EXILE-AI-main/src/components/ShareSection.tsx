import { useState } from "react";
import { Share2, Copy, Mail, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const ctl = "border border-cyan-500/40 bg-transparent text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-40";

/** Compose something and hand it to the system share sheet, or to an app link you choose. */
const ShareSection = () => {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");

  const full = [text.trim(), url.trim()].filter(Boolean).join("\n");
  const canNative = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const empty = !full && !title.trim();

  const share = async () => {
    try {
      await navigator.share({ title: title.trim() || undefined, text: text.trim() || undefined, url: url.trim() || undefined });
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") toast.error("Sharing was not completed.");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([title.trim(), full].filter(Boolean).join("\n"));
      toast.success("Copied.");
    } catch {
      toast.error("Copy was blocked by the browser.");
    }
  };

  const open = (href: string) => window.open(href, "_blank", "noopener,noreferrer");

  return (
    <div className="p-4 space-y-3 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Share2 className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">SHARE HUB</h2>
      </div>
      <p className="text-[11px] text-cyan-400/70">
        Write a message, then send it with your device's share sheet or open it in an email or WhatsApp compose window. EXILE does not post anything itself and does not hold your social accounts.
      </p>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title or subject (optional)" aria-label="Title" className="bg-slate-900 border-cyan-500/30 text-cyan-100" />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Message" aria-label="Message" className="bg-slate-900 border-cyan-500/30 text-cyan-100 text-xs" />
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link (optional)" aria-label="Link" className="bg-slate-900 border-cyan-500/30 text-cyan-100" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" className={ctl} disabled={empty || !canNative} onClick={() => void share()} title={canNative ? undefined : "This browser has no system share sheet"}>
          <Share2 className="w-3.5 h-3.5 mr-1.5" /> Share…
        </Button>
        <Button size="sm" variant="ghost" className={ctl} disabled={empty} onClick={() => void copy()}><Copy className="w-3.5 h-3.5 mr-1.5" /> Copy</Button>
        <Button size="sm" variant="ghost" className={ctl} disabled={empty} onClick={() => open(`mailto:?subject=${encodeURIComponent(title.trim())}&body=${encodeURIComponent(full)}`)}>
          <Mail className="w-3.5 h-3.5 mr-1.5" /> Email
        </Button>
        <Button size="sm" variant="ghost" className={ctl} disabled={empty} onClick={() => open(`https://wa.me/?text=${encodeURIComponent([title.trim(), full].filter(Boolean).join("\n"))}`)}>
          <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> WhatsApp
        </Button>
      </div>
      {!canNative && <p className="text-[10px] text-cyan-500/60">This browser has no system share sheet, so “Share…” is unavailable. Copy, Email and WhatsApp still work.</p>}
    </div>
  );
};

export default ShareSection;
