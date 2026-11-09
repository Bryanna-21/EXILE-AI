import { Brain, Cog } from "lucide-react";
import { AGENTS } from "@/lib/agents";
import { agentActivity, formatClock } from "@/lib/missionControl";
import type { ReasoningEvent } from "@/lib/reasoningLog";
import type { ApiFailure } from "@/lib/taskApi";
import type { TaskCapabilities, TaskSummary } from "@/types/tasks";
import { Pill, SectionTitle, StateBanner } from "./ui";

interface Props {
  capabilities: TaskCapabilities | null;
  capabilitiesFailure: ApiFailure | null;
  log: ReasoningEvent[];
  tasks: TaskSummary[];
}

const AgentPanel = ({ capabilities, capabilitiesFailure, log, tasks }: Props) => {
  const activity = agentActivity(log, AGENTS.map((a) => a.name));
  const personas = AGENTS.filter((a) => a.status === "persona");
  const planned = AGENTS.filter((a) => a.status === "planned");
  const running = tasks.filter((t) => t.status === "running" || t.status === "planning").length;

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-cyan-500/30 bg-slate-900/60 p-3">
        <SectionTitle icon={<Cog className="w-4 h-4" />} right={capabilities ? <Pill tone={capabilities.planner.configured ? "ok" : "warn"}>{capabilities.planner.configured ? "Planner ready" : "No provider"}</Pill> : undefined}>
          Task engine
        </SectionTitle>
        <p className="text-[11px] text-cyan-200/70 mb-2">
          Tasks are executed by one engine that plans with a model and runs only the registered tools below.
          It does not use the personas; it currently has {running} task{running === 1 ? "" : "s"} running.
        </p>
        {capabilitiesFailure && !capabilities && (
          <StateBanner tone="warn" title="Engine details unavailable">{capabilitiesFailure.message}</StateBanner>
        )}
        {capabilities && (
          <>
            <div className="text-[10px] text-cyan-400/70 mb-2">
              {capabilities.planner.configured
                ? `Planning provider: ${capabilities.planner.providers.join(", ")}.`
                : `No planning provider has a key (permitted: ${capabilities.planner.permitted.join(", ")}). New tasks will fail at planning.`}
              {" "}Limits: {capabilities.limits.maxSteps} steps, {Math.round(capabilities.limits.taskTimeoutMs / 60000)} min per task.
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {capabilities.tools.map((t) => (
                <li key={t.name} className={`rounded border p-2 ${t.available ? "border-cyan-500/25 bg-slate-900/40" : "border-slate-700/60 bg-slate-900/30 opacity-70"}`}>
                  <div className="flex items-center gap-2">
                    <code className="text-[11px] text-cyan-100 truncate flex-1">{t.name}</code>
                    <Pill tone={t.available ? "ok" : "idle"}>{t.available ? "available" : "offline"}</Pill>
                  </div>
                  <div className="text-[10px] text-cyan-300/70 mt-0.5">{t.description}</div>
                  <div className="text-[9px] tracking-widest uppercase mt-1 text-cyan-500/70">
                    {t.risk}{t.approvalRequired ? " · asks for approval" : ""}
                  </div>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-cyan-500/60 mt-2">Checked {formatClock(capabilities.checkedAt)}</div>
          </>
        )}
      </section>

      <section className="rounded-md border border-cyan-500/30 bg-slate-900/60 p-3">
        <SectionTitle icon={<Brain className="w-4 h-4" />}>Console personas</SectionTitle>
        <p className="text-[11px] text-cyan-200/70 mb-2">
          A persona is a system prompt plus keyword routing in the Console. All personas use the same model and tools;
          they are not separate running agents. “Handled” counts requests the Console actually routed to each one.
        </p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {personas.map((a) => {
            const act = activity[a.name];
            return (
              <li key={a.id} className="rounded border border-cyan-400/30 bg-cyan-500/5 p-2">
                <div className="flex items-center gap-2">
                  <a.icon className="w-4 h-4 text-cyan-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-cyan-100 truncate">{a.name}</div>
                    <div className="text-[9px] tracking-widest uppercase text-cyan-400/60 truncate">{a.role}</div>
                  </div>
                  <Pill tone="info">persona</Pill>
                </div>
                <div className="text-[10px] text-cyan-300/70 mt-1">
                  {act.handled === 0
                    ? "Nothing routed here yet."
                    : `Handled ${act.handled} · last ${act.lastAt ? new Date(act.lastAt).toLocaleTimeString() : "—"}${act.lastDetail ? `: “${act.lastDetail}”` : ""}`}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3">
          <div className="text-[10px] tracking-widest uppercase text-cyan-500/70 mb-1">Planned (not built)</div>
          <ul className="flex flex-wrap gap-1.5">
            {planned.map((a) => (
              <li key={a.id} title={`${a.role}. Listed for the roadmap; it has no prompt and is never used.`} className="inline-flex items-center gap-1 rounded border border-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400">
                <a.icon className="w-3 h-3" /> {a.name}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
};

export default AgentPanel;
