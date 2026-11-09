/** Shapes of the local task service (local/task-api.mjs). */

export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped";

export interface TaskEvent {
  seq: number;
  at: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface TaskAttempt {
  attempt: number;
  at: string;
  result: { ok: boolean; output: string | null; error: string | null; recoverable: boolean };
}

export interface TaskStep {
  id: string;
  intent: string;
  kind: "tool" | "reasoning" | "verification";
  tool: string | null;
  args: Record<string, unknown>;
  dependsOn: string[];
  status: StepStatus;
  attempts: TaskAttempt[];
  output: string | null;
  error: string | null;
  recoveryNotes: string[];
  recoveryNote?: string;
  uncertainSideEffects?: boolean;
  requiresApproval: boolean;
  approval: { requestId: string; summary: string; decision: string | null } | null;
  verificationResult: { passed: boolean; method: string; reason: string } | null;
}

export type ApprovalDecision = "approved" | "refused" | "expired" | null;

export interface TaskApproval {
  requestId: string;
  stepId: string;
  tool: string;
  decision: ApprovalDecision;
  createdAt: string;
  decidedAt?: string;
}

export interface TaskErrorInfo {
  stage: string;
  reason?: string;
  details?: unknown;
  stepId?: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  createdAt: string | null;
  updatedAt: string | null;
  plan: { summary?: string; title?: string; blockedCapabilities?: string[] } | null;
  steps: TaskStep[];
  approvals: TaskApproval[];
  events: TaskEvent[];
  verification: { passed: boolean; method?: string; evidence?: string; reason?: string; at?: string } | null;
  result: { summary?: string } | null;
  error: TaskErrorInfo | null;
  recovery: { interruptedAt?: string; recoveredAt?: string; note?: string } | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  createdAt: string | null;
  updatedAt: string | null;
  stepsTotal: number;
  stepsCompleted: number;
  stepsFailed: number;
  stepsSkipped: number;
  currentStep: { id: string; intent: string; status: StepStatus } | null;
  pendingApprovals: number;
  hasRecovery: boolean;
  error: { stage: string; reason: string } | null;
  resultSummary: string | null;
  verificationPassed: boolean | null;
}

export interface TaskToolInfo {
  name: string;
  description: string;
  risk: "safe" | "reversible" | "sensitive" | "destructive";
  approvalRequired: boolean;
  available: boolean;
}

export interface TaskCapabilities {
  checkedAt: string;
  planner: { configured: boolean; providers: string[]; permitted: string[] };
  limits: { maxSteps: number; taskTimeoutMs: number };
  tools: TaskToolInfo[];
}

export type TaskAction = "start" | "resume" | "pause" | "cancel";
