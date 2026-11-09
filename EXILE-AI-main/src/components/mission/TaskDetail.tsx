import { useState } from "react";
import { ArrowLeft, Check, Pause, Play, RotateCcw, ShieldAlert, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ApiFailure } from "@/lib/taskApi";
import {
  allowedActions, describeFailure, formatClock, pendingApprovals, progressOf, statusMeta, summaryFromRecord,
  timelineOf, toolsUsed, ACTION_LABELS,
} from "@/lib/missionControl";
import type { StepStatus, TaskAction, TaskRecord } from "@/types/tasks";
import { Progress } from "@/components/ui/progress";
import { Pill, SectionTitle, StateBanner, ToneIcon } from "./ui";
import { toneText } from "./tone";

interface Props {
  detail: TaskRecord | null;
  failure: ApiFailure | null;
  busy: string | undefined;
  /** True when the service is unreachable and the data shown may be out of date. */
  stale: boolean;
  onAction: (action: TaskAction) => void;
  onDecide: (requestId: string, approved: boolean) => void;
  onClose: () => void;
}

const STEP_TONE: Record<StepStatus, "ok" | "info" | "warn" | "bad" | "idle"> = {
  pending: "idle", running: "info", waiting_approval: "warn", completed: "ok", failed: "bad", skipped: "warn",
};

const preview = (s: string | null | undefined, max = 400) => (s && s.length > max ? `${s.slice(0, max)}…` : s ?? "");

const TaskDetail = ({ detail, failure, busy, stale, onAction, onDecide, onClose }: Props) => {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const back = (
    <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-100">
      <ArrowLeft className="w-3.5 h-3.5" /> All tasks
    </button>
  );

  if (!detail) {
    return (
      <div className="space-y-3">
        {back}
        {failure ? (
          <StateBanner tone={failure.kind === "not-found" ? "warn" : "bad"} title={failure.kind === "not-found" ? "This task no longer exists" : "Could not load this task"}>
            {failure.message}
          </StateBanner>
        ) : (
          <div role="status" className="text-xs text-cyan-400/70">Loading task…</div>
        )}
      </div>
    );
  }

  const summary = summaryFromRecord(detail);
  const meta = statusMeta(detail.status);
  const progress = progressOf(summary);
  const actions = allowedActions(detail.status);
  const failureText = describeFailure(summary);
  const approvals = pendingApprovals(detail);
  const timeline = timelineOf(detail.events, "newest");
  const tools = toolsUsed(detail);
  const working = !!busy;

  const controlButton = (action: TaskAction, icon: React.ReactNode, allowed: boolean) =>
    allowed ? (
      <Button
        key={action} size="sm" variant="ghost" disabled={working || stale}
        onClick={() => (action === "cancel" ? setConfirmCancel(true) : onAction(action))}
        className="h-8 border border-cyan-500/40 text-cyan-100"
      >
        {icon} {busy === action ? ACTION_LABELS[action].busy : ACTION_LABELS[action].verb}
      </Button>
    ) : null;

  return (
    <div className="space-y-4">
      {back}

      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <ToneIcon tone={meta.tone} spinning={detail.status === "running" || detail.status === "planning"} className="w-4 h-4 mt-0.5" />
          <h3 className="flex-1 text-sm text-cyan-100 break-words">{detail.title || detail.objective}</h3>
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </div>
        <p className="text-[11px] text-cyan-200/70 whitespace-pre-wrap break-words">{detail.objective}</p>
        <div className="flex items-center gap-2">
          <Progress value={progress.percent} className="h-1.5 flex-1 bg-slate-800" indicatorClassName="bg-cyan-400" aria-label={`Progress ${progress.percent}%`} />
          <span className="text-[10px] text-cyan-400/70 whitespace-nowrap">{progress.label}</span>
        </div>
        <div className="text-[10px] text-cyan-500/70">
          Started {formatClock(detail.createdAt)} · Updated {formatClock(detail.updatedAt)}
        </div>
        <div className="text-[10px] text-cyan-400/70">
          Run by: the EXILE task engine{tools.length ? ` · tools: ${tools.join(", ")}` : ""}
        </div>
        <div className="flex gap-2 flex-wrap" role="group" aria-label="Task controls">
          {controlButton("start", <Play className="w-3.5 h-3.5 mr-1" />, actions.start)}
          {controlButton("resume", <RotateCcw className="w-3.5 h-3.5 mr-1" />, actions.resume)}
          {controlButton("pause", <Pause className="w-3.5 h-3.5 mr-1" />, actions.pause)}
          {controlButton("cancel", <Square className="w-3.5 h-3.5 mr-1" />, actions.cancel)}
          {!actions.start && !actions.resume && !actions.pause && !actions.cancel && (
            <span className="text-[10px] text-cyan-500/60">This task has finished; no controls apply.</span>
          )}
        </div>
        {stale && <div className="text-[10px] text-amber-300">Controls are disabled while the task service is unreachable.</div>}
      </div>

      {failure && <StateBanner tone="warn" title="Refresh problem">{failure.message} Showing the last data received.</StateBanner>}

      {approvals.length > 0 && (
        <div className="space-y-2" aria-label="Approval requests">
          {approvals.map((a) => (
            <div key={a.requestId} className="rounded-md border border-amber-400/50 bg-amber-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-amber-200">
                <ShieldAlert className="w-4 h-4" />
                <span className="text-xs tracking-widest uppercase">Approval required</span>
              </div>
              <p className="text-xs text-amber-100">{a.intent || a.summary}</p>
              <p className="text-[11px] text-amber-100/80">
                Tool: <code className="text-amber-200">{a.tool}</code>. {a.summary}
              </p>
              <div>
                <div className="text-[10px] tracking-widest uppercase text-amber-300/80 mb-1">Exact arguments you are approving</div>
                <pre className="max-h-40 overflow-auto rounded bg-slate-950/70 border border-amber-400/20 p-2 text-[10px] text-amber-100 whitespace-pre-wrap break-words">{a.argsText}</pre>
                {a.argsTruncated && <div className="text-[10px] text-amber-300 mt-1">Long arguments are shortened here; the full text is what runs.</div>}
              </div>
              <p className="text-[10px] text-amber-200/70">
                Approval covers only these exact arguments, once. Changing anything requires a new approval.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={working || stale} onClick={() => onDecide(a.requestId, true)} className="h-8 bg-emerald-500/20 border border-emerald-400/50 text-emerald-100">
                  <Check className="w-3.5 h-3.5 mr-1" /> {busy === "approve" ? "Approving…" : "Approve this operation"}
                </Button>
                <Button size="sm" variant="ghost" disabled={working || stale} onClick={() => onDecide(a.requestId, false)} className="h-8 border border-red-400/50 text-red-200">
                  <X className="w-3.5 h-3.5 mr-1" /> {busy === "refuse" ? "Refusing…" : "Refuse"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail.recovery && (
        <StateBanner tone="warn" title="Recovered after a restart">
          {detail.recovery.note} Interrupted {formatClock(detail.recovery.interruptedAt)}, recovered {formatClock(detail.recovery.recoveredAt)}.
          {detail.steps.some((s) => s.uncertainSideEffects) && " A step that was mid-flight will not be repeated automatically; its outcome is uncertain."}
        </StateBanner>
      )}

      {failureText && <StateBanner tone="bad" title="This task failed">{failureText}</StateBanner>}
      {detail.status === "cancelled" && <StateBanner tone="idle" title="This task was cancelled">{detail.result?.summary ?? "It was stopped before finishing."}</StateBanner>}
      {detail.status === "completed" && (
        <StateBanner tone="ok" title="Completed and verified">
          {detail.result?.summary}
          {detail.verification?.evidence ? ` Evidence: ${preview(detail.verification.evidence, 240)}` : ""}
        </StateBanner>
      )}

      <section>
        <SectionTitle icon={<Check className="w-4 h-4" />} right={<span className="text-[9px] text-cyan-400/60 tracking-widest">{detail.steps.length} STEPS</span>}>Steps</SectionTitle>
        {detail.steps.length === 0 ? (
          <p className="text-[11px] text-cyan-400/60 italic">
            {detail.status === "planning" ? "The plan is being prepared…" : detail.status === "queued" ? "No plan yet. Steps appear after the task starts." : "No plan was produced."}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {detail.steps.map((s, i) => (
              <li key={s.id} className="rounded border border-cyan-500/20 bg-slate-900/40 p-2">
                <div className="flex items-center gap-2">
                  <ToneIcon tone={STEP_TONE[s.status]} spinning={s.status === "running"} />
                  <span className="text-[11px] text-cyan-100 flex-1 break-words">{i + 1}. {s.intent}</span>
                  <Pill tone={STEP_TONE[s.status]}>{s.status.replace("_", " ")}</Pill>
                </div>
                <div className="mt-1 text-[10px] text-cyan-400/70 flex gap-2 flex-wrap">
                  <span>{s.kind}{s.tool ? ` · ${s.tool}` : ""}</span>
                  {s.requiresApproval && <span className="text-amber-300">needs approval</span>}
                  {s.attempts.length > 1 && <span>{s.attempts.length} attempts</span>}
                  {s.uncertainSideEffects && <span className="text-amber-300">outcome uncertain</span>}
                </div>
                {s.error && <div className={`mt-1 text-[10px] ${toneText.bad} break-words`}>{preview(s.error)}</div>}
                {s.status === "completed" && s.output && <div className="mt-1 text-[10px] text-cyan-200/70 break-words">{preview(s.output, 240)}</div>}
                {s.verificationResult && (
                  <div className={`mt-1 text-[10px] ${s.verificationResult.passed ? toneText.ok : toneText.bad}`}>
                    {s.verificationResult.passed ? "Verified" : "Not verified"}: {s.verificationResult.reason}
                  </div>
                )}
                {[...(s.recoveryNote ? [s.recoveryNote] : []), ...(s.recoveryNotes ?? [])].map((n, j) => (
                  <div key={j} className="mt-1 text-[10px] text-amber-300/90">{n}</div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <SectionTitle icon={<RotateCcw className="w-4 h-4" />} right={<span className="text-[9px] text-cyan-400/60 tracking-widest">{timeline.length} EVENTS</span>}>Timeline</SectionTitle>
        {timeline.length === 0 ? (
          <p className="text-[11px] text-cyan-400/60 italic">No events yet.</p>
        ) : (
          <ol className="space-y-1 max-h-72 overflow-y-auto font-mono pr-1">
            {timeline.map((e) => (
              <li key={e.seq} className="flex gap-2 text-[10px]">
                <span className="text-cyan-500/60 shrink-0">{formatClock(e.at)}</span>
                <ToneIcon tone={e.tone} className="w-3 h-3 mt-px shrink-0" />
                <span className="text-cyan-100/80 break-words min-w-0">
                  <span className={toneText[e.tone]}>{e.title}</span> · {e.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent className="bg-slate-950 border-cyan-500/40 text-cyan-100">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this task?</AlertDialogTitle>
            <AlertDialogDescription className="text-cyan-300/80">
              The task stops and cannot be restarted. Steps that already ran are not undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-cyan-500/40 text-cyan-100">Keep running</AlertDialogCancel>
            <AlertDialogAction className="bg-red-500/30 border border-red-400/50 text-red-100" onClick={() => onAction("cancel")}>
              Cancel task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TaskDetail;
