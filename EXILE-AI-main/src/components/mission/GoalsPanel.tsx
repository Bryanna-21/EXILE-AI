import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Link2, Plus, Target, Trash2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  GOAL_LIMITS, addGoal, addMilestone, createGoalsStore, deleteGoal, goalProgress, linkMilestoneTask, milestoneState,
  removeMilestone, setMilestoneDone, updateGoal, type Goal, type MilestoneState, type Result, type TaskStatusLookup,
} from "@/lib/goals";
import type { ApiResult } from "@/lib/taskApi";
import type { TaskRecord, TaskSummary } from "@/types/tasks";
import { Pill, SectionTitle, StateBanner } from "./ui";

interface Props {
  tasks: TaskSummary[];
  /** False until the task list has loaded at least once. Linked milestones then show "unknown" instead of guessing. */
  tasksKnown: boolean;
  disconnected: boolean;
  onCreateTask: (objective: string, start: boolean) => Promise<ApiResult<TaskRecord>>;
  onOpenTask: (id: string) => void;
}

const MILESTONE_LABEL: Record<MilestoneState, { text: string; tone: "ok" | "info" | "warn" | "bad" | "idle" }> = {
  "done": { text: "done", tone: "ok" },
  "done-by-task": { text: "done by task", tone: "ok" },
  "in-progress": { text: "task running", tone: "info" },
  "blocked": { text: "task ended without completing", tone: "bad" },
  "task-unknown": { text: "task status unknown", tone: "warn" },
  "todo": { text: "to do", tone: "idle" },
};

const store = createGoalsStore(
  typeof window !== "undefined" ? window.localStorage : null,
  () => window.dispatchEvent(new CustomEvent("exile:goals-updated")),
);

const GoalsPanel = ({ tasks, tasksKnown, disconnected, onCreateTask, onOpenTask }: Props) => {
  const [goals, setGoals] = useState<Goal[]>(() => store.load());
  const [title, setTitle] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null);
  const [milestoneDrafts, setMilestoneDrafts] = useState<Record<string, string>>({});
  const [storageBlocked, setStorageBlocked] = useState(false);

  useEffect(() => {
    const reload = () => setGoals(store.load());
    window.addEventListener("exile:goals-updated", reload);
    return () => window.removeEventListener("exile:goals-updated", reload);
  }, []);

  const statuses: TaskStatusLookup = useMemo(
    () => (tasksKnown ? Object.fromEntries(tasks.map((t) => [t.id, t.status])) : null),
    [tasks, tasksKnown],
  );

  const apply = useCallback((result: Result<Goal[]>): boolean => {
    if (result.ok === false) {
      toast.error((result as { ok: false; error: string }).error);
      return false;
    }
    setGoals(result.value);
    setStorageBlocked(!store.save(result.value));
    return true;
  }, []);

  const visible = goals.filter((g) => (showArchived ? g.status === "archived" : g.status === "active"));
  const archivedCount = goals.filter((g) => g.status === "archived").length;

  const createGoal = () => {
    if (apply(addGoal(goals, { title, targetDate: targetDate || null }))) {
      setTitle("");
      setTargetDate("");
    }
  };

  const runAsTask = async (goal: Goal, milestoneId: string, milestoneTitle: string) => {
    const r = await onCreateTask(`${goal.title}: ${milestoneTitle}`, false);
    if (r.ok) apply(linkMilestoneTask(goals, goal.id, milestoneId, r.data.id));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-cyan-500/25 bg-slate-900/60 p-3 space-y-2">
        <label htmlFor="goal-title" className="text-[10px] tracking-widest text-cyan-300 uppercase">New goal</label>
        <div className="flex gap-2 flex-wrap">
          <Input
            id="goal-title" value={title} maxLength={GOAL_LIMITS.title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createGoal(); }}
            placeholder="e.g. Launch the beta"
            className="flex-1 min-w-[180px] bg-slate-950 border-cyan-500/30 text-cyan-100 text-xs"
          />
          <Input
            type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-label="Target date (optional)"
            className="w-40 bg-slate-950 border-cyan-500/30 text-cyan-100 text-xs"
          />
          <Button size="sm" onClick={createGoal} disabled={!title.trim()} className="h-9 bg-cyan-500/20 border border-cyan-400/40 text-cyan-100">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add goal
          </Button>
        </div>
        <p className="text-[10px] text-cyan-400/60">
          Break a goal into milestones. A milestone counts as done when you tick it or when a task you linked to it completes
          (tasks only complete after their verification passes). Goals are stored on this computer.
        </p>
      </div>

      {storageBlocked && (
        <StateBanner tone="warn" title="Goals could not be saved">
          This browser profile blocked storage, so your changes will be lost when you leave this page.
        </StateBanner>
      )}
      {disconnected && goals.some((g) => g.milestones.some((m) => m.taskId)) && (
        <StateBanner tone="warn" title="Task service unreachable">
          Linked milestones show “task status unknown” until it reconnects. Nothing is guessed.
        </StateBanner>
      )}

      <div className="flex items-center justify-between">
        <SectionTitle icon={<Target className="w-4 h-4" />}>{showArchived ? "Archived goals" : "Goals"}</SectionTitle>
        {(archivedCount > 0 || showArchived) && (
          <button type="button" className="text-[10px] text-cyan-300 hover:text-cyan-100" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Show active" : `Show archived (${archivedCount})`}
          </button>
        )}
      </div>

      {visible.length === 0 && (
        <p className="text-[11px] text-cyan-400/60 italic">{showArchived ? "No archived goals." : "No goals yet. Add one above, then give it milestones."}</p>
      )}

      <ul className="space-y-3">
        {visible.map((g) => {
          const p = goalProgress(g, statuses);
          const draft = milestoneDrafts[g.id] ?? "";
          return (
            <li key={g.id} className="rounded-md border border-cyan-500/30 bg-slate-900/60 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-cyan-100 break-words">{g.title}</div>
                  <div className="text-[10px] text-cyan-400/70 flex gap-2 flex-wrap mt-0.5">
                    {p.achieved && <Pill tone="ok">achieved</Pill>}
                    {p.overdue && <Pill tone="bad">overdue by {Math.abs(p.daysLeft ?? 0)}d</Pill>}
                    {g.targetDate && !p.overdue && !p.achieved && <span>Target {g.targetDate}{p.daysLeft !== null ? ` · ${p.daysLeft}d left` : ""}</span>}
                    {g.targetDate && p.achieved && <span>Target {g.targetDate}</span>}
                  </div>
                </div>
                <Button
                  size="sm" variant="ghost" className="h-7 px-2 text-cyan-300"
                  onClick={() => apply(updateGoal(goals, g.id, { status: g.status === "active" ? "archived" : "active" }))}
                  aria-label={g.status === "active" ? `Archive goal ${g.title}` : `Restore goal ${g.title}`}
                >
                  {g.status === "active" ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-red-300" onClick={() => setPendingDelete(g)} aria-label={`Delete goal ${g.title}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Progress value={p.percent} className="h-1.5 flex-1 bg-slate-800" indicatorClassName="bg-cyan-400" aria-label={`Goal progress ${p.percent}%`} />
                <span className="text-[10px] text-cyan-400/70 whitespace-nowrap">{p.done}/{p.total} milestones</span>
              </div>

              <ul className="space-y-1">
                {g.milestones.map((m) => {
                  const state = milestoneState(m, statuses);
                  const label = MILESTONE_LABEL[state];
                  const doneByTask = state === "done-by-task";
                  return (
                    <li key={m.id} className="flex items-center gap-2 rounded bg-slate-950/40 px-2 py-1">
                      <Checkbox
                        checked={m.done || doneByTask}
                        disabled={doneByTask}
                        onCheckedChange={(v) => apply(setMilestoneDone(goals, g.id, m.id, v === true))}
                        aria-label={`Mark milestone ${m.title} done`}
                      />
                      <span className={`flex-1 min-w-0 text-xs break-words ${m.done || doneByTask ? "text-cyan-300/60 line-through" : "text-cyan-100"}`}>{m.title}</span>
                      <Pill tone={label.tone}>{label.text}</Pill>
                      {m.taskId ? (
                        <>
                          <button type="button" className="text-cyan-300 hover:text-cyan-100" onClick={() => onOpenTask(m.taskId as string)} aria-label={`Open task for ${m.title}`} title="Open linked task">
                            <Link2 className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" className="text-cyan-500/70 hover:text-cyan-200" onClick={() => apply(linkMilestoneTask(goals, g.id, m.id, null))} aria-label={`Unlink task from ${m.title}`} title="Unlink task">
                            <Unlink className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button" disabled={disconnected} onClick={() => runAsTask(g, m.id, m.title)}
                          className="text-[10px] text-cyan-300 hover:text-cyan-100 disabled:opacity-40 whitespace-nowrap"
                          title={disconnected ? "Task service unreachable" : "Create a task for this milestone and link it"}
                        >
                          Run as task
                        </button>
                      )}
                      <button type="button" className="text-red-300/70 hover:text-red-200" onClick={() => apply(removeMilestone(goals, g.id, m.id))} aria-label={`Remove milestone ${m.title}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex gap-2">
                <Input
                  value={draft} maxLength={GOAL_LIMITS.title} placeholder="Add a milestone"
                  aria-label={`New milestone for ${g.title}`}
                  onChange={(e) => setMilestoneDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim() && apply(addMilestone(goals, g.id, draft))) setMilestoneDrafts((d) => ({ ...d, [g.id]: "" }));
                  }}
                  className="h-8 bg-slate-950 border-cyan-500/30 text-cyan-100 text-xs"
                />
                <Button
                  size="sm" variant="ghost" disabled={!draft.trim()} className="h-8 border border-cyan-500/40 text-cyan-100"
                  onClick={() => { if (apply(addMilestone(goals, g.id, draft))) setMilestoneDrafts((d) => ({ ...d, [g.id]: "" })); }}
                >
                  Add
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent className="bg-slate-950 border-cyan-500/40 text-cyan-100">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this goal?</AlertDialogTitle>
            <AlertDialogDescription className="text-cyan-300/80">
              “{pendingDelete?.title}” and its milestones will be removed. Linked tasks are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-cyan-500/40 text-cyan-100">Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500/30 border border-red-400/50 text-red-100"
              onClick={() => { if (pendingDelete) { const next = deleteGoal(goals, pendingDelete.id); setGoals(next); setStorageBlocked(!store.save(next)); } setPendingDelete(null); }}
            >
              Delete goal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default GoalsPanel;
