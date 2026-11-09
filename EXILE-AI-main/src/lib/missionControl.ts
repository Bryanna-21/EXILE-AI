/**
 * Pure view-model helpers for Mission Control. No React, no network, no storage:
 * everything here turns task-service data into what the screen shows, so the
 * rules (what may be paused, what counts as "needs attention", how a failure is
 * worded) are testable and cannot drift from the backend by accident.
 */

import type {
  TaskAction,
  TaskApproval,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskSummary,
} from "../types/tasks";

export type Tone = "ok" | "info" | "warn" | "bad" | "idle";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

const STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "idle" },
  planning: { label: "Planning", tone: "info" },
  running: { label: "Running", tone: "info" },
  waiting_approval: { label: "Needs approval", tone: "warn" },
  paused: { label: "Paused", tone: "warn" },
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "idle" },
};

export function statusMeta(status: string): { label: string; tone: Tone } {
  return STATUS_META[status as TaskStatus] ?? { label: status || "Unknown", tone: "idle" };
}

export const isTerminal = (status: string) => TERMINAL_STATUSES.has(status as TaskStatus);
export const isLive = (status: string) => ["planning", "running", "waiting_approval"].includes(status);

export interface ActionSet {
  start: boolean;
  resume: boolean;
  pause: boolean;
  cancel: boolean;
}

/**
 * Which controls make sense for a status. Mirrors the backend state machine
 * (local/task-states.mjs): a queued task cannot be paused, a paused task is
 * resumed rather than started, finished tasks accept nothing.
 */
export function allowedActions(status: string): ActionSet {
  switch (status) {
    case "queued": return { start: true, resume: false, pause: false, cancel: true };
    case "planning":
    case "running":
    case "waiting_approval": return { start: false, resume: false, pause: true, cancel: true };
    case "paused": return { start: false, resume: true, pause: false, cancel: true };
    default: return { start: false, resume: false, pause: false, cancel: false };
  }
}

export const ACTION_LABELS: Record<TaskAction, { verb: string; busy: string; done: string }> = {
  start: { verb: "Start", busy: "Starting…", done: "Task started." },
  resume: { verb: "Resume", busy: "Resuming…", done: "Task resumed." },
  pause: { verb: "Pause", busy: "Pausing…", done: "Pause requested. The task stops after its current step." },
  cancel: { verb: "Cancel", busy: "Cancelling…", done: "Cancellation requested." },
};

export interface Progress {
  done: number;
  total: number;
  percent: number;
  label: string;
}

type ProgressInput = Pick<TaskSummary, "status" | "stepsTotal" | "stepsCompleted" | "stepsSkipped">;

export function progressOf(task: ProgressInput): Progress {
  const total = task.stepsTotal;
  const done = task.stepsCompleted + task.stepsSkipped;
  if (total === 0) {
    const label = task.status === "planning" ? "Planning steps…" : task.status === "queued" ? "Not started" : "No steps";
    return { done: 0, total: 0, percent: 0, label };
  }
  const percent = task.status === "completed" ? 100 : Math.min(99, Math.round((done / total) * 100));
  return { done, total, percent, label: `${done} of ${total} steps` };
}

export function summaryFromRecord(t: TaskRecord): TaskSummary {
  const steps = t.steps ?? [];
  const current =
    steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "waiting_approval") ?? steps.find((s) => s.status === "pending") ?? null;
  return {
    id: t.id,
    title: t.title,
    objective: t.objective,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    stepsTotal: steps.length,
    stepsCompleted: steps.filter((s) => s.status === "completed").length,
    stepsFailed: steps.filter((s) => s.status === "failed").length,
    stepsSkipped: steps.filter((s) => s.status === "skipped").length,
    currentStep: current ? { id: current.id, intent: current.intent, status: current.status } : null,
    pendingApprovals: (t.approvals ?? []).filter((a) => a.decision === null).length,
    hasRecovery: !!t.recovery,
    error: t.error ? { stage: t.error.stage, reason: String(t.error.reason ?? "") } : null,
    resultSummary: t.result?.summary ?? null,
    verificationPassed: typeof t.verification?.passed === "boolean" ? t.verification.passed : null,
  };
}

const STAGE_TEXT: Record<string, string> = {
  planning: "Planning failed",
  execution: "A step failed",
  verification: "Verification did not pass",
  timeout: "The task timed out",
  approval: "Approval could not be honoured",
  recovery: "Recovery stopped the task",
  internal: "Internal error",
};

/** Plain-language failure line for a summary or record. Null when there is nothing to report. */
export function describeFailure(task: Pick<TaskSummary, "status" | "error">): string | null {
  if (task.status !== "failed" && !task.error) return null;
  if (!task.error) return task.status === "failed" ? "The task failed without recording a reason." : null;
  const head = STAGE_TEXT[task.error.stage] ?? "The task failed";
  const reason = task.error.reason?.trim();
  return reason ? `${head}: ${reason}` : head;
}

export interface TaskGroups {
  attention: TaskSummary[];
  active: TaskSummary[];
  history: TaskSummary[];
}

const byUpdatedDesc = (a: TaskSummary, b: TaskSummary) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0;

/**
 * attention: something is waiting on the operator (approval, or a task that was
 * interrupted by a restart and must be reviewed before resuming).
 */
export function groupTasks(tasks: TaskSummary[]): TaskGroups {
  const attention: TaskSummary[] = [];
  const active: TaskSummary[] = [];
  const history: TaskSummary[] = [];
  for (const t of tasks) {
    if (isTerminal(t.status)) history.push(t);
    else if (t.status === "waiting_approval" || (t.status === "paused" && t.hasRecovery)) attention.push(t);
    else active.push(t);
  }
  return { attention: attention.sort(byUpdatedDesc), active: active.sort(byUpdatedDesc), history: history.sort(byUpdatedDesc) };
}

export function countByStatus(tasks: TaskSummary[]) {
  const c = { total: tasks.length, running: 0, waiting: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, queued: 0 };
  for (const t of tasks) {
    if (t.status === "running" || t.status === "planning") c.running++;
    else if (t.status === "waiting_approval") c.waiting++;
    else if (t.status === "paused") c.paused++;
    else if (t.status === "completed") c.completed++;
    else if (t.status === "failed") c.failed++;
    else if (t.status === "cancelled") c.cancelled++;
    else c.queued++;
  }
  return c;
}

/* ------------------------------- timeline ------------------------------- */

export interface TimelineItem {
  seq: number;
  at: string;
  type: string;
  tone: Tone;
  title: string;
  message: string;
  stepId: string | null;
}

const EVENT_META: Record<string, { title: string; tone: Tone }> = {
  planning: { title: "Planning", tone: "info" },
  plan: { title: "Plan ready", tone: "info" },
  running: { title: "Running", tone: "info" },
  step_started: { title: "Step started", tone: "info" },
  tool_result: { title: "Tool succeeded", tone: "ok" },
  tool_error: { title: "Tool error", tone: "warn" },
  step_verified: { title: "Step verified", tone: "ok" },
  step_completed: { title: "Step finished", tone: "ok" },
  step_failed: { title: "Step failed", tone: "bad" },
  step_skipped: { title: "Step skipped", tone: "warn" },
  verification_failed: { title: "Verification failed", tone: "bad" },
  adaptation: { title: "Plan adjusted", tone: "info" },
  approval_request: { title: "Approval requested", tone: "warn" },
  approval_wait: { title: "Waiting for approval", tone: "warn" },
  approval: { title: "Approval answered", tone: "info" },
  waiting_approval: { title: "Waiting for approval", tone: "warn" },
  paused: { title: "Paused", tone: "warn" },
  cancelled: { title: "Cancelled", tone: "idle" },
  recovery: { title: "Recovered after restart", tone: "warn" },
  uncertain_side_effect_blocked: { title: "Not repeated", tone: "warn" },
  completed: { title: "Completed", tone: "ok" },
  failed: { title: "Failed", tone: "bad" },
};

export function timelineOf(events: TaskEvent[] | undefined, order: "oldest" | "newest" = "newest"): TimelineItem[] {
  const items = (events ?? []).map<TimelineItem>((e) => {
    const meta = EVENT_META[e.type] ?? { title: e.type.replace(/_/g, " "), tone: "idle" as Tone };
    const stepId = typeof e.data?.stepId === "string" ? e.data.stepId : null;
    return { seq: e.seq, at: e.at, type: e.type, tone: meta.tone, title: meta.title, message: e.message, stepId };
  });
  items.sort((a, b) => a.seq - b.seq);
  return order === "newest" ? items.reverse() : items;
}

/* ------------------------------- approvals ------------------------------- */

export interface PendingApproval {
  requestId: string;
  stepId: string;
  tool: string;
  intent: string;
  summary: string;
  argsText: string;
  argsTruncated: boolean;
}

const ARGS_PREVIEW_MAX = 1500;

/** Unanswered approvals with the exact arguments that the approval is bound to. */
export function pendingApprovals(task: Pick<TaskRecord, "approvals" | "steps">): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const a of task.approvals ?? ([] as TaskApproval[])) {
    if (a.decision !== null) continue;
    const step = (task.steps ?? []).find((s) => s.id === a.stepId);
    let text = "{}";
    try {
      text = JSON.stringify(step?.args ?? {}, null, 2);
    } catch {
      text = "(arguments could not be displayed)";
    }
    out.push({
      requestId: a.requestId,
      stepId: a.stepId,
      tool: a.tool,
      intent: step?.intent ?? "",
      summary: step?.approval?.summary ?? `Run ${a.tool}`,
      argsText: text.length > ARGS_PREVIEW_MAX ? `${text.slice(0, ARGS_PREVIEW_MAX)}…` : text,
      argsTruncated: text.length > ARGS_PREVIEW_MAX,
    });
  }
  return out;
}

/* ---------------------------- polling policy ---------------------------- */

export const POLL = { listMs: 4000, detailMs: 1500, disconnectedMs: 8000, hiddenMs: 15000 } as const;

/** How long to wait before the next refresh. Slower when hidden or when the service is unreachable. */
export function nextPollDelay(opts: { hidden: boolean; connected: boolean; hasLiveTask: boolean; detailOpen: boolean }): number {
  if (!opts.connected) return POLL.disconnectedMs;
  if (opts.hidden) return POLL.hiddenMs;
  if (opts.detailOpen && opts.hasLiveTask) return POLL.detailMs;
  return POLL.listMs;
}

/* --------------------------- agent assignments --------------------------- */

export interface AgentActivityEvent {
  ts: number;
  agent: string;
  action: string;
  detail?: string;
}

export interface AgentActivity {
  handled: number;
  lastAt: number | null;
  lastDetail: string | null;
}

/** Actions the Console logs when it routes a request to a persona (src/pages/Index.tsx, ChatSection.tsx). */
const ROUTING_ACTIONS = new Set(["Received directive", "handling request"]);

/** What each persona has actually been given to handle, taken from the real routing log. */
export function agentActivity(log: AgentActivityEvent[], agentNames: string[]): Record<string, AgentActivity> {
  const out: Record<string, AgentActivity> = {};
  for (const n of agentNames) out[n] = { handled: 0, lastAt: null, lastDetail: null };
  for (const e of log) {
    if (!ROUTING_ACTIONS.has(e.action)) continue;
    const slot = out[e.agent];
    if (!slot) continue;
    slot.handled++;
    if (slot.lastAt === null || e.ts > slot.lastAt) {
      slot.lastAt = e.ts;
      slot.lastDetail = e.detail ? String(e.detail).slice(0, 120) : null;
    }
  }
  return out;
}

/** Tools a task actually used, in plan order, de-duplicated. */
export function toolsUsed(task: Pick<TaskRecord, "steps">): string[] {
  const seen = new Set<string>();
  for (const s of task.steps ?? []) if (s.tool) seen.add(s.tool);
  return [...seen];
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString() : "—";
}
