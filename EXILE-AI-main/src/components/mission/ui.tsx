import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, PauseCircle, XCircle, Info } from "lucide-react";
import type { Tone } from "@/lib/missionControl";
import { toneText } from "./tone";

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-emerald-300 border-emerald-400/40 bg-emerald-500/10",
  info: "text-cyan-200 border-cyan-400/40 bg-cyan-500/10",
  warn: "text-amber-200 border-amber-400/40 bg-amber-500/10",
  bad: "text-red-300 border-red-400/40 bg-red-500/10",
  idle: "text-slate-300 border-slate-500/40 bg-slate-500/10",
};


export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-widest whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function ToneIcon({ tone, spinning = false, className = "w-3.5 h-3.5" }: { tone: Tone; spinning?: boolean; className?: string }) {
  if (spinning) return <Loader2 className={`${className} animate-spin ${toneText[tone]}`} aria-hidden />;
  const cls = `${className} ${toneText[tone]}`;
  if (tone === "ok") return <CheckCircle2 className={cls} aria-hidden />;
  if (tone === "bad") return <XCircle className={cls} aria-hidden />;
  if (tone === "warn") return <AlertTriangle className={cls} aria-hidden />;
  if (tone === "info") return <Info className={cls} aria-hidden />;
  return <CircleDashed className={cls} aria-hidden />;
}

export function PausedIcon() {
  return <PauseCircle className="w-3.5 h-3.5 text-amber-300" aria-hidden />;
}

/** A banner for loading, error, timeout and disconnected states. */
export function StateBanner({
  tone, title, children, action,
}: { tone: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`rounded-md border p-3 text-xs ${TONE_CLASS[tone]}`}>
      <div className="flex items-start gap-2">
        <ToneIcon tone={tone} className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium tracking-wide">{title}</div>
          {children && <div className="text-[11px] opacity-90 leading-relaxed">{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function SectionTitle({ icon, children, right }: { icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2 text-cyan-300">
        {icon}
        <h3 className="text-xs tracking-widest text-cyan-200 uppercase">{children}</h3>
      </div>
      {right}
    </div>
  );
}
