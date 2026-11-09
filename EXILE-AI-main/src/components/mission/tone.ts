import type { Tone } from "@/lib/missionControl";

export const toneText: Record<Tone, string> = {
  ok: "text-emerald-300",
  info: "text-cyan-300",
  warn: "text-amber-300",
  bad: "text-red-300",
  idle: "text-slate-400",
};
