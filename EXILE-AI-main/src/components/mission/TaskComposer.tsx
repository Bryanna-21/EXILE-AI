import { useState } from "react";
import { Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OBJECTIVE_MAX, type ApiResult } from "@/lib/taskApi";
import type { TaskRecord } from "@/types/tasks";
import { StateBanner } from "./ui";

interface Props {
  onCreate: (objective: string, start: boolean) => Promise<ApiResult<TaskRecord>>;
  /** null while capabilities are still unknown (loading or unreachable). */
  plannerConfigured: boolean | null;
  disconnected: boolean;
}

const TaskComposer = ({ onCreate, plannerConfigured, disconnected }: Props) => {
  const [objective, setObjective] = useState("");
  const [pending, setPending] = useState<null | "create" | "start">(null);

  const trimmed = objective.trim();
  const tooLong = trimmed.length > OBJECTIVE_MAX;
  const blocked = disconnected || pending !== null;

  const submit = async (start: boolean) => {
    if (!trimmed || tooLong || blocked) return;
    setPending(start ? "start" : "create");
    const r = await onCreate(trimmed, start);
    setPending(null);
    if (r.ok) setObjective("");
  };

  return (
    <div className="rounded-md border border-cyan-500/25 bg-slate-900/60 p-3 space-y-2">
      <label htmlFor="mission-objective" className="text-[10px] tracking-widest text-cyan-300 uppercase">
        New task
      </label>
      <Textarea
        id="mission-objective"
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="Describe the outcome you want, e.g. “Save a memory note that my standup is at 9:00, then verify it was stored.”"
        rows={3}
        maxLength={OBJECTIVE_MAX + 200}
        disabled={disconnected}
        className="bg-slate-950 border-cyan-500/30 text-cyan-100 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit(true);
          }
        }}
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className={`text-[10px] ${tooLong ? "text-red-300" : "text-cyan-400/60"}`}>
          {trimmed.length}/{OBJECTIVE_MAX}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!trimmed || tooLong || blocked} onClick={() => submit(false)} className="border border-cyan-500/40 text-cyan-100 h-8">
            <Plus className="w-3.5 h-3.5 mr-1" /> {pending === "create" ? "Creating…" : "Create"}
          </Button>
          <Button size="sm" disabled={!trimmed || tooLong || blocked} onClick={() => submit(true)} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100 h-8">
            <Play className="w-3.5 h-3.5 mr-1" /> {pending === "start" ? "Starting…" : "Create & start"}
          </Button>
        </div>
      </div>
      {plannerConfigured === false && (
        <StateBanner tone="warn" title="No reasoning provider is configured">
          Tasks need a model to plan their steps, so a new task will fail at planning until a provider key is added in the API section.
          Existing tasks are unaffected.
        </StateBanner>
      )}
    </div>
  );
};

export default TaskComposer;
