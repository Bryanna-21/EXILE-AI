import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/mission/ui";
import { detectLocalApi, endpoint } from "@/lib/ai";
import { taskClient } from "@/lib/taskClient";
import { nativeApps, nativeAppsAvailable } from "@/lib/nativeApps";
import { evaluateSystems, overallState, type CheckRow, type CheckState } from "@/lib/systemsCheck";

const TONE: Record<CheckState, "ok" | "warn" | "bad" | "idle"> = { ok: "ok", warn: "warn", down: "bad", "n/a": "idle" };
const LABEL: Record<CheckState, string> = { ok: "ok", warn: "limited", down: "down", "n/a": "n/a" };

async function probeHealth(): Promise<{ providers: string[]; keysDetected: number } | null> {
  try {
    const base = await detectLocalApi(true);
    if (!base) return null;
    const r = await fetch(endpoint("health"), { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      providers: Array.isArray(j.providers) ? j.providers.filter((p: unknown) => typeof p === "string") : [],
      keysDetected: Number(j.keysDetected) || 0,
    };
  } catch {
    return null;
  }
}

/** Systems Monitor: live checks of what this app actually depends on. */
const DashboardSection = () => {
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const run = useCallback(async () => {
    setBusy(true);
    const health = await probeHealth();
    const tasks = health ? await taskClient.getCapabilities() : null;
    let count: number | null = null;
    if (nativeAppsAvailable()) {
      const r = await nativeApps.list();
      if (r.ok === true) count = r.apps.length;
    }
    if (!alive.current) return;
    setRows(evaluateSystems({
      browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
      health,
      tasks: tasks && tasks.ok === true ? tasks.data : null,
      desktopBridge: nativeAppsAvailable(),
      nativeAppCount: count,
    }));
    setCheckedAt(Date.now());
    setBusy(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    void run();
    return () => { alive.current = false; };
  }, [run]);

  const overall = overallState(rows);

  return (
    <div className="p-4 space-y-3 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center justify-between">
        <h2 className="text-sm tracking-widest flex items-center gap-2"><Activity className="w-4 h-4 text-cyan-300" /> SYSTEMS MONITOR</h2>
        {rows.length > 0 && <Pill tone={TONE[overall.state]}>{overall.label}</Pill>}
      </div>
      <p className="text-[11px] text-cyan-400/70">Each line below comes from a real check made just now. Nothing here is simulated.</p>
      <ul className="space-y-1.5" aria-label="System checks">
        {rows.length === 0 && <li role="status" className="text-xs text-cyan-500/70">Checking…</li>}
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded border border-cyan-500/20 bg-slate-900/40 p-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-cyan-100">{r.name}</div>
              <div className="text-[11px] text-cyan-300/70">{r.detail}</div>
            </div>
            <Pill tone={TONE[r.state]}>{LABEL[r.state]}</Pill>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run()} className="border border-cyan-500/40 text-cyan-100 hover:bg-cyan-500/10">
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${busy ? "animate-spin" : ""}`} /> Check again
        </Button>
        {checkedAt && <span className="text-[10px] text-cyan-500/60">Checked {new Date(checkedAt).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
};

export default DashboardSection;
