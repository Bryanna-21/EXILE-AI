/**
 * Client for EXILE's local task service (local/task-api.mjs).
 *
 * This is the only code in the renderer that talks to /tasks. It adds no
 * orchestration of its own. Every failure is returned as a classified
 * { ok:false, kind } value so the UI can show distinct, truthful states
 * (disconnected, timed out, refused, conflict ...) instead of a generic error.
 *
 * It has no imports from the app (only types), so the same file is exercised in
 * tests against the real HTTP handler.
 */

import type {
  TaskAction,
  TaskCapabilities,
  TaskEvent,
  TaskRecord,
  TaskSummary,
} from "../types/tasks";

export type ApiErrorKind =
  | "disconnected"
  | "timeout"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "invalid"
  | "server"
  | "malformed"
  | "challenge-unavailable";

export interface ApiFailure {
  ok: false;
  kind: ApiErrorKind;
  message: string;
  status?: number;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/** The project compiles with strict:false, where `if (!r.ok)` does not narrow; use this guard instead. */
export function isFailure<T>(r: ApiResult<T>): r is ApiFailure {
  return r.ok === false;
}

export interface TaskClientOptions {
  /** Resolves the local API base URL ("" when no local service could be found). */
  getBase: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called after a network-level failure so the caller can re-detect the service port. */
  onDisconnected?: () => void;
}

export const OBJECTIVE_MAX = 4000;

const MESSAGES = {
  disconnected:
    "Cannot reach EXILE's local task service. Make sure the EXILE desktop app (or the local server) is running on this computer.",
  timeout: "The task service did not answer in time. It may be busy; try again in a moment.",
  forbidden: "The task service refused this request. It only accepts requests from the local EXILE app.",
  server: (status: number) => `The task service hit an error (HTTP ${status}).`,
  malformed: "The task service sent a reply EXILE could not understand.",
  challengeUnavailable:
    "This approval's one-time code was already used, or the service restarted. Cancel the task and run it again to get a fresh approval request.",
} as const;

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 405 || status === 413) return "invalid";
  return "server";
}

export function createTaskClient(options: TaskClientOptions) {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 8000;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    pick: (json: Record<string, unknown>) => T | undefined,
  ): Promise<ApiResult<T>> {
    let base = "";
    try {
      base = await options.getBase();
    } catch {
      base = "";
    }
    if (!base) {
      options.onDisconnected?.();
      return { ok: false, kind: "disconnected", message: MESSAGES.disconnected };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (timedOut) return { ok: false, kind: "timeout", message: MESSAGES.timeout };
      options.onDisconnected?.();
      return { ok: false, kind: "disconnected", message: MESSAGES.disconnected };
    }

    let json: Record<string, unknown> | null = null;
    try {
      const parsed = await response.json();
      json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      if (timedOut) {
        clearTimeout(timer);
        return { ok: false, kind: "timeout", message: MESSAGES.timeout };
      }
    }
    clearTimeout(timer);

    if (!response.ok) {
      const kind = kindFromStatus(response.status);
      const serverMessage = typeof json?.error === "string" && json.error.trim() ? json.error : "";
      const message =
        kind === "forbidden" ? MESSAGES.forbidden
        : kind === "server" ? MESSAGES.server(response.status)
        : serverMessage || MESSAGES.server(response.status);
      return { ok: false, kind, message, status: response.status };
    }

    if (!json || json.ok !== true) return { ok: false, kind: "malformed", message: MESSAGES.malformed, status: response.status };
    const data = pick(json);
    if (data === undefined) return { ok: false, kind: "malformed", message: MESSAGES.malformed, status: response.status };
    return { ok: true, data };
  }

  const enc = encodeURIComponent;
  const asTask = (j: Record<string, unknown>) => (j.task && typeof j.task === "object" ? (j.task as TaskRecord) : undefined);

  return {
    listTasks: () =>
      request<TaskSummary[]>("GET", "/tasks?view=summary", undefined, (j) => (Array.isArray(j.tasks) ? (j.tasks as TaskSummary[]) : undefined)),

    getTask: (id: string) => request<TaskRecord>("GET", `/tasks/${enc(id)}`, undefined, asTask),

    getEvents: (id: string) =>
      request<TaskEvent[]>("GET", `/tasks/${enc(id)}/events`, undefined, (j) => (Array.isArray(j.events) ? (j.events as TaskEvent[]) : undefined)),

    getCapabilities: () =>
      request<TaskCapabilities>("GET", "/tasks/capabilities", undefined, (j) =>
        j.planner && Array.isArray(j.tools)
          ? ({ checkedAt: String(j.checkedAt ?? ""), planner: j.planner, limits: j.limits, tools: j.tools } as TaskCapabilities)
          : undefined,
      ),

    async createTask(input: { objective: string; title?: string; start?: boolean }): Promise<ApiResult<TaskRecord>> {
      const objective = input.objective.trim();
      if (!objective) return { ok: false, kind: "invalid", message: "Describe what the task should achieve." };
      if (objective.length > OBJECTIVE_MAX) {
        return { ok: false, kind: "invalid", message: `Objectives are limited to ${OBJECTIVE_MAX} characters (this one is ${objective.length}).` };
      }
      return request<TaskRecord>("POST", "/tasks", { objective, title: input.title?.trim() || undefined, start: input.start === true }, asTask);
    },

    control: (id: string, action: TaskAction) => request<TaskRecord>("POST", `/tasks/${enc(id)}/${action}`, {}, asTask),

    /**
     * Answer an approval request. The service issues a one-time code per request;
     * it is fetched only now, at the moment the operator decides, and used once.
     */
    async decideApproval(taskId: string, requestId: string, approved: boolean): Promise<ApiResult<TaskRecord>> {
      const challenge = await request<string>(
        "GET",
        `/tasks/${enc(taskId)}/approval-challenge?requestId=${enc(requestId)}`,
        undefined,
        (j) => (typeof j.token === "string" && j.token ? j.token : undefined),
      );
      if (isFailure(challenge)) {
        return challenge.kind === "not-found"
          ? { ok: false, kind: "challenge-unavailable", message: MESSAGES.challengeUnavailable, status: challenge.status }
          : challenge;
      }
      return request<TaskRecord>("POST", `/tasks/${enc(taskId)}/approve`, { requestId, token: challenge.data, approved: approved === true }, asTask);
    },
  };
}

export type TaskClient = ReturnType<typeof createTaskClient>;
