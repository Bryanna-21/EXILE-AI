import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TranscriptTurn, listTurns, deleteTurn, clearTranscript } from "@/lib/conversation";

const TranscriptSection = () => {
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);

  useEffect(() => {
    const load = () => setTurns(listTurns());
    load();
    window.addEventListener("exile:transcript", load);
    return () => window.removeEventListener("exile:transcript", load);
  }, []);

  return (
    <div className="p-4 space-y-4 text-cyan-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm tracking-[0.3em] text-cyan-300">CHAT HISTORY</h3>
          <p className="text-xs text-cyan-400/60 mt-1">
            Every directive and reply, stored on this device. Nothing is deleted automatically.
          </p>
        </div>
        {turns.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => clearTranscript()}
            className="text-red-300 border border-red-400/30 text-xs"
          >
            Clear all
          </Button>
        )}
      </div>

      <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
        {turns.length === 0 && <p className="text-xs text-cyan-400/50">No conversations recorded yet.</p>}
        {turns.map((t) => (
          <div
            key={t.id}
            className={`rounded-md border p-3 ${
              t.role === "user"
                ? "border-cyan-400/40 bg-cyan-500/10 ml-8"
                : "border-cyan-500/20 bg-slate-900/60 mr-8"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] tracking-[0.3em] text-cyan-400/70 uppercase">
                {t.role === "user" ? "YOU" : "EXILE"} · {new Date(t.at).toLocaleString()}
              </span>
              <button onClick={() => deleteTurn(t.id)} aria-label="Delete message" className="text-red-300/70 hover:text-red-200">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-sm leading-7 whitespace-pre-wrap mt-1.5">{t.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TranscriptSection;
