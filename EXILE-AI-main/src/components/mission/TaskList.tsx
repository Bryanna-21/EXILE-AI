import { History, ShieldQuestion, Activity } from "lucide-react";
import { describeFailure, formatClock, groupTasks, progressOf, statusMeta, isLive } from "@/lib/missionControl";
import type { TaskSummary } from "@/types/tasks";
import { Pill, SectionTitle, ToneIcon } from "./ui";
import { Progress } from "@/components/ui/progress";

interface Props {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const Row = ({ t, selected, onSelect }: { t: TaskSummary; selected: boolean; onSelect: (id: string) => void }) => {
  const meta = statusMeta(t.status);
  const p = progressOf(t);
  const failure = t.status === "failed" ? describeFailure(t) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(t.id)}
        aria-current={selected ? "true" : undefined}
        className={`w-full text-left rounded border p-2 transition ${
          selected ? "border-cyan-300/70 bg-cyan-500/15" : "border-cyan-500/20 bg-slate-900/40 hover:bg-cyan-500/10 hover:border-cyan-400/50"
        }`}
      >
        <div className="flex items-center gap-2">
          <ToneIcon tone={meta.tone} spinning={t.status === "running" || t.status === "planning"} />
          <span className="text-xs text-cyan-100 truncate flex-1">{t.title || t.objective}</span>
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </div>
        {t.pendingApprovals > 0 && (
          <div className="mt-1 text-[10px] text-amber-300">
            {t.pendingApprovals} approval{t.pendingApprovals === 1 ? "" : "s"} waiting for you
          </div>
        )}
        {t.hasRecovery && t.status === "paused" && (
          <div className="mt-1 text-[10px] text-amber-300">Interrupted by a restart. Review it, then resume.</div>
        )}
        {failure && <div className="mt-1 text-[10px] text-red-300 line-clamp-2">{failure}</div>}
        <div className="mt-1.5 flex items-center gap-2">
          <Progress value={p.percent} className="h-1 flex-1 bg-slate-800" indicatorClassName="bg-cyan-400" aria-label={`Progress ${p.percent}%`} />
          <span className="text-[9px] text-cyan-400/70 whitespace-nowrap">{p.label}</span>
        </div>
        {isLive(t.status) && t.currentStep && (
          <div className="mt-1 text-[10px] text-cyan-300/80 truncate">Now: {t.currentStep.intent}</div>
        )}
        <div className="mt-1 text-[9px] text-cyan-500/60">Updated {formatClock(t.updatedAt)}</div>
      </button>
    </li>
  );
};

const Group = ({ title, icon, tasks, selectedId, onSelect, empty }: { title: string; icon: React.ReactNode; tasks: TaskSummary[]; selectedId: string | null; onSelect: (id: string) => void; empty?: string }) => {
  if (tasks.length === 0 && !empty) return null;
  return (
    <div>
      <SectionTitle icon={icon} right={<span className="text-[9px] text-cyan-400/60 tracking-widest">{tasks.length}</span>}>{title}</SectionTitle>
      {tasks.length === 0 ? (
        <p className="text-[11px] text-cyan-400/60 italic">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((t) => <Row key={t.id} t={t} selected={t.id === selectedId} onSelect={onSelect} />)}
        </ul>
      )}
    </div>
  );
};

const TaskList = ({ tasks, selectedId, onSelect }: Props) => {
  const g = groupTasks(tasks);
  return (
    <div className="space-y-4">
      <Group title="Needs your attention" icon={<ShieldQuestion className="w-4 h-4" />} tasks={g.attention} selectedId={selectedId} onSelect={onSelect} />
      <Group title="Active" icon={<Activity className="w-4 h-4" />} tasks={g.active} selectedId={selectedId} onSelect={onSelect} empty={g.attention.length ? undefined : "No active tasks. Create one above."} />
      <Group title="History" icon={<History className="w-4 h-4" />} tasks={g.history} selectedId={selectedId} onSelect={onSelect} />
    </div>
  );
};

export default TaskList;
