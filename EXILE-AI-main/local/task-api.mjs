import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./task-store.mjs";
import { PermissionGateway } from "./permission-gateway.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { TaskOrchestrator } from "./task-orchestrator.mjs";
import { summarizeTask } from "./task-summary.mjs";
import { checkLocalRequest, localAuth } from "./local-auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.EXILE_DATA_DIR
  ? path.resolve(process.env.EXILE_DATA_DIR)
  : ROOT;

const TASK_STORE_DIR = process.env.EXILE_TASK_STORE_DIR
  ? path.resolve(process.env.EXILE_TASK_STORE_DIR)
  : path.join(DATA_DIR, ".exile-ai", "tasks");

const store = new TaskStore(TASK_STORE_DIR);
await store.recoverInterrupted();

const gateway = new PermissionGateway();
const registry = new ToolRegistry();

const PLANNER_PROVIDERS = {
  gemini: {
    key: "GEMINI_API_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
  },
  openrouter: {
    key: "OPENROUTER_API_KEY",
    base: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
  },
};

// Preserve EXILE's free-tier policy. No paid-provider fallback.
function plannerProviderOrder() {
  return process.env.EXILE_GEMINI_FREE_TIER === "true"
    ? ["gemini", "openrouter"]
    : ["openrouter"];
}

/** Which permitted reasoning providers have a key. Reports booleans and ids only, never keys. */
function defaultPlannerStatus() {
  const permitted = plannerProviderOrder();
  const configured = permitted.filter((id) => !!process.env[PLANNER_PROVIDERS[id].key]);
  return { configured: configured.length > 0, providers: configured, permitted };
}

/**
 * Build the permitted planner provider caller.
 * The task signal cancels the actual fetch; a provider timeout still permits fallback.
 */
export function createPlannerCallModel({
  fetchImpl = (...args) => fetch(...args),
  env = process.env,
  getProviderOrder = plannerProviderOrder,
} = {}) {
  return async function callModel(messages, { signal } = {}) {
    const order = getProviderOrder();
    const providers = PLANNER_PROVIDERS;
    let lastError = "No permitted free reasoning provider is configured.";

    for (const id of order) {
      const provider = providers[id];
      const key = env[provider.key];
      if (!key) continue;

      try {
        const timeoutSignal = AbortSignal.timeout(90000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        const response = await fetchImpl(`${provider.base}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: provider.model,
            messages,
            stream: false,
            temperature: 0.2,
          }),
          signal: requestSignal,
        });

        if (!response.ok) {
          lastError = `${id} returned HTTP ${response.status}.`;
          continue;
        }

        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
          ? content.map((part) => part?.text ?? "").join("")
          : String(content ?? "");

        if (text.trim()) return text;
        lastError = `${id} returned an empty response.`;
      } catch (error) {
        // A task cancellation must not silently start a fallback provider request.
        if (signal?.aborted) throw error;
        lastError = `${id} request failed: ${error.message}`;
      }
    }

    throw new Error(lastError);
  };
}

const callModel = createPlannerCallModel();

const orchestrator = new TaskOrchestrator({
  store,
  registry,
  gateway,
  callModel,
});

function send(res, status, payload) {
  res.writeHead(status, {
    // Echo the caller's (already validated, local) origin; never a wildcard.
    "Access-Control-Allow-Origin": res.exileOrigin ?? "null",
    Vary: "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      throw Object.assign(new Error("Task request body is too large."), {
        statusCode: 413,
      });
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), {
      statusCode: 400,
    });
  }
}

function taskError(res, error) {
  send(res, error.statusCode || 400, {
    ok: false,
    error: error.message || "Task request failed.",
  });
}

/**
 * Build the /tasks request handler around explicit dependencies. The default
 * export below wires the real store, registry and orchestrator; tests inject
 * their own so the real routing, origin checks and state machine run end to end.
 * (Body intentionally not re-indented to keep this diff reviewable.)
 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Strict request-body schemas. Unknown field types are rejected, not coerced. */
export function parseCreateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Request body must be a JSON object.");
  if (typeof body.objective !== "string" || !body.objective.trim()) throw badRequest("objective must be a non-empty string.");
  if (body.objective.length > 4000) throw badRequest("objective must be 4000 characters or fewer.");
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 200)) throw badRequest("title must be a string of at most 200 characters.");
  if (body.start !== undefined && typeof body.start !== "boolean") throw badRequest("start must be a boolean.");
  return { objective: body.objective, title: body.title, start: body.start === true };
}

export function parseApproveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Request body must be a JSON object.");
  if (typeof body.requestId !== "string" || !REQUEST_ID_RE.test(body.requestId)) throw badRequest("requestId must be a valid approval request id.");
  // A missing token is passed through as "" so the gateway answers 403 "Invalid approval token".
  if (body.token !== undefined && (typeof body.token !== "string" || body.token.length > 200)) throw badRequest("token must be the approval token issued for this request.");
  // Anything other than a literal `true` is a refusal: ambiguity never grants approval.
  return { requestId: body.requestId, token: body.token ?? "", approved: body.approved === true };
}

function taskIdFrom(raw) {
  let id;
  try { id = decodeURIComponent(raw); } catch { throw badRequest("Malformed task id."); }
  if (!TASK_ID_RE.test(id)) throw badRequest("Malformed task id.");
  return id;
}

export function createTaskApiHandler({ store, orchestrator, registry, plannerStatus, auth }) {
return async function handleTaskApi(req, res, url) {
  if (url.pathname !== "/tasks" && !url.pathname.startsWith("/tasks/")) {
    return false;
  }

  const origin = req.headers.origin;
  res.exileOrigin = origin && origin !== "" ? origin : "null";
  const denied = checkLocalRequest(req, auth);
  if (denied) {
    send(res, denied.status, { ok: false, error: denied.error });
    return true;
  }

  try {
    if (req.method === "GET" && url.pathname === "/tasks") {
      const tasks = store.list();
      return send(res, 200, {
        ok: true,
        tasks: url.searchParams.get("view") === "summary" ? tasks.map(summarizeTask) : tasks,
      }), true;
    }

    // What the task engine can really do right now: planner provider + per-tool availability.
    if (req.method === "GET" && url.pathname === "/tasks/capabilities") {
      const availability = registry.availability();
      send(res, 200, {
        ok: true,
        checkedAt: new Date().toISOString(),
        planner: plannerStatus(),
        limits: {
          maxSteps: orchestrator.limits.maxSteps,
          taskTimeoutMs: orchestrator.limits.taskTimeoutMs,
        },
        tools: registry.catalog().map((t) => ({
          name: t.name,
          description: t.description,
          risk: t.risk,
          approvalRequired: t.approvalRequired,
          available: availability[t.name] === true,
        })),
      });
      return true;
    }

    const eventMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
    const challengeMatch = url.pathname.match(/^\/tasks\/([^/]+)\/approval-challenge$/);
    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);

    if (req.method === "GET" && eventMatch) {
      const task = store.get(taskIdFrom(eventMatch[1]));
      if (!task) {
        send(res, 404, { ok: false, error: "Task not found." });
      } else {
        send(res, 200, { ok: true, events: task.events ?? [] });
      }
      return true;
    }

    if (req.method === "GET" && taskMatch) {
      const task = store.get(taskIdFrom(taskMatch[1]));
      send(res, task ? 200 : 404, task
        ? { ok: true, task }
        : { ok: false, error: "Task not found." });
      return true;
    }

    if (req.method === "GET" && challengeMatch) {
      const requestId = url.searchParams.get("requestId");
      taskIdFrom(challengeMatch[1]);
      if (!requestId || !REQUEST_ID_RE.test(requestId)) {
        send(res, 400, { ok: false, error: "requestId is required." });
      } else {
        const token = orchestrator.takeApprovalChallenge(challengeMatch[1], requestId);
        send(res, token ? 200 : 404, token
          ? { ok: true, requestId, token }
          : { ok: false, error: "No unused approval challenge is available." });
      }
      return true;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      send(res, 405, { ok: false, error: "Method not allowed." });
      return true;
    }

    const body = await readRequestBody(req);

    if (url.pathname === "/tasks") {
      const parsed = parseCreateBody(body);
      const task = orchestrator.createTask({
        objective: parsed.objective,
        title: parsed.title,
      });
      if (parsed.start) {
        await orchestrator.startOrResume(task.id);
      }
      send(res, 201, { ok: true, task: store.get(task.id) });
      return true;
    }

    const actionMatch = url.pathname.match(
      /^\/tasks\/([^/]+)\/(start|resume|pause|cancel|approve)$/
    );

    if (!actionMatch) {
      send(res, 404, { ok: false, error: "Unknown task endpoint." });
      return true;
    }

    const taskId = taskIdFrom(actionMatch[1]);
    const action = actionMatch[2];
    let task;

    if (action === "start" || action === "resume") {
      task = await orchestrator.startOrResume(taskId);
    } else if (action === "pause") {
      task = orchestrator.requestPause(taskId);
    } else if (action === "cancel") {
      task = orchestrator.requestCancel(taskId);
    } else {
      const decision = parseApproveBody(body);
      task = await orchestrator.decideApproval({
        taskId,
        requestId: decision.requestId,
        token: decision.token,
        approved: decision.approved,
      });
    }

    send(res, 200, { ok: true, task });
    return true;
  } catch (error) {
    taskError(res, error);
    return true;
  }
};
}

export const handleTaskApi = createTaskApiHandler({
  store,
  orchestrator,
  registry,
  plannerStatus: defaultPlannerStatus,
  auth: localAuth,
});
