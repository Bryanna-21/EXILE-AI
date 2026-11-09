/**
 * Lightweight task summaries for list views.
 *
 * GET /tasks returns full records (every step attempt and up to 300 events), which
 * is wasteful to poll. A summary carries only what a list row needs. It is
 * derived purely from the stored record, so it can never disagree with it.
 */

const ACTIVE_STEP_ORDER = ["running", "waiting_approval", "pending"];

export function summarizeTask(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const approvals = Array.isArray(task?.approvals) ? task.approvals : [];

  let currentStep = null;
  for (const status of ACTIVE_STEP_ORDER) {
    const hit = steps.find((s) => s.status === status);
    if (hit) {
      currentStep = { id: hit.id, intent: String(hit.intent ?? "").slice(0, 200), status: hit.status };
      break;
    }
  }

  const error = task?.error && typeof task.error === "object"
    ? {
        stage: typeof task.error.stage === "string" ? task.error.stage : "unknown",
        reason: String(task.error.reason ?? (Array.isArray(task.error.details) ? task.error.details.join(" ") : "")).slice(0, 300),
      }
    : null;

  return {
    id: task.id,
    title: task.title,
    objective: task.objective,
    status: task.status,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    stepsTotal: steps.length,
    stepsCompleted: steps.filter((s) => s.status === "completed").length,
    stepsFailed: steps.filter((s) => s.status === "failed").length,
    stepsSkipped: steps.filter((s) => s.status === "skipped").length,
    currentStep,
    pendingApprovals: approvals.filter((a) => a.decision === null).length,
    hasRecovery: !!task?.recovery,
    error,
    resultSummary: typeof task?.result?.summary === "string" ? task.result.summary.slice(0, 300) : null,
    verificationPassed: typeof task?.verification?.passed === "boolean" ? task.verification.passed : null,
  };
}
