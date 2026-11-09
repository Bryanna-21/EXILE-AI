import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// The module-level default instance in task-api.mjs opens a store at import time.
// Point it at a throwaway directory so tests never write into the repository.
const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-task-default-"));
process.env.EXILE_TASK_STORE_DIR = defaultDir;

const { createTaskApiHandler, handleTaskApi } = await import("../local/task-api.mjs");
const { TaskStore } = await import("../local/task-store.mjs");
const { ToolRegistry, TOOL_DEFINITIONS } = await import("../local/tool-registry.mjs");
const { PermissionGateway } = await import("../local/permission-gateway.mjs");
const { TaskOrchestrator } = await import("../local/task-orchestrator.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [() => fs.rmSync(defaultDir, { recursive: true, force: true })];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

/* ------------------------------ test harness ------------------------------ */

function plan(steps, title = "Test plan") {
  return JSON.stringify({ title, summary: `${title} summary`, steps, blockedCapabilities: [] });
}

const saveStep = (key = "k1", value = "v1") => ({
  id: "s1", intent: "Save a note", kind: "tool", tool: "save_memory_note", args: { key, value },
  dependsOn: [], expectedOutput: "saved", verification: { method: "output_present" },
});
const verifyStep = (dependsOn = ["s1"], key = "k1", value = "v1") => ({
  id: "verify", intent: "Verify the note", kind: "verification", tool: "verify_memory_note",
  args: { key, expectedValue: value }, dependsOn, expectedOutput: "verified", verification: { method: "state_check" },
});

async function makeApi({ script, extraTools = [], limits } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-task-api-"));
  const store = new TaskStore(dir);
  const registry = new ToolRegistry([...TOOL_DEFINITIONS, ...extraTools]);
  const gateway = new PermissionGateway();
  const modelCalls = [];
  const callModel = async (messages) => {
    modelCalls.push(messages);
    const system = messages[0]?.content ?? "";
    if (/revise EXILE task plans/.test(system)) return JSON.stringify({ action: "abandon", note: "give up" });
    if (/task reasoner/.test(system)) return "reasoned answer";
    if (typeof script === "function") return script(messages);
    return script;
  };
  const orchestrator = new TaskOrchestrator({ store, registry, gateway, callModel, limits: { taskTimeoutMs: 30000, ...limits } });
  const handler = createTaskApiHandler({
    store, orchestrator, registry,
    plannerStatus: () => ({ configured: true, providers: ["test"], permitted: ["test"] }),
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (await handler(req, res, url)) return;
    res.writeHead(404).end("not handled");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(close);

  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json, headers: res.headers };
  };

  const waitFor = async (id, statuses, ms = 12000) => {
    const want = new Set([].concat(statuses));
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = (await call("GET", `/tasks/${id}`)).json?.task;
      if (last && want.has(last.status)) return last;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${[...want]} (last status: ${last?.status})`);
  };

  return { dir, store, registry, orchestrator, gateway, call, waitFor, base, modelCalls, close };
}

/* ---------------------------------- tests ---------------------------------- */

test("origin policy: only the local app may use the task API", async () => {
  const api = await makeApi({ script: "" });
  const evil = { Origin: "https://evil.example" };
  for (const [method, p, body] of [["GET", "/tasks", undefined], ["GET", "/tasks/capabilities", undefined], ["POST", "/tasks", { objective: "x" }], ["GET", "/tasks/abcdef123/events", undefined]]) {
    const r = await api.call(method, p, body, evil);
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match(r.json.error, /restricted to the local app/);
  }
  for (const origin of ["null", "file://", "http://localhost:8080", "http://127.0.0.1:5173", undefined]) {
    const r = await api.call("GET", "/tasks", undefined, origin ? { Origin: origin } : {});
    assert.equal(r.status, 200, String(origin));
  }
  assert.equal((await api.call("GET", "/tasks", undefined, { Origin: "http://localhost.evil.example" })).status, 403);
  assert.equal((await api.call("GET", "/tasks", undefined, { Origin: "http://127.0.0.1.evil.example" })).status, 403);
  assert.equal((await api.call("GET", "/tasks")).headers.get("cache-control"), "no-store");
});

test("create validates input and body size", async () => {
  const api = await makeApi({ script: "" });
  assert.equal((await api.call("POST", "/tasks", {})).status, 400);
  assert.equal((await api.call("POST", "/tasks", { objective: "   " })).status, 400);
  assert.equal((await api.call("POST", "/tasks", { objective: "x".repeat(4001) })).status, 400);
  assert.equal((await api.call("POST", "/tasks", "{ not json")).status, 400);
  assert.equal((await api.call("POST", "/tasks", { objective: "x".repeat(70 * 1024) })).status, 413);
  assert.equal((await api.call("DELETE", "/tasks/abcdef123")).status, 405);
  assert.equal((await api.call("POST", "/tasks/abcdef123/explode", {})).status, 404);
  assert.equal((await api.call("GET", "/tasks/does-not-exist")).status, 404);
  assert.equal((await api.call("GET", "/tasks/does-not-exist/events")).status, 404);
  assert.equal((await api.call("GET", "/tasks/../../etc/passwd")).status >= 400, true);
  assert.equal((await api.call("GET", "/tasks/..%2F..%2Fetc%2Fpasswd")).status, 400);
  const created = await api.call("POST", "/tasks", { objective: "A valid objective" });
  assert.equal(created.status, 201);
  assert.equal(created.json.task.status, "queued");
  assert.equal(created.json.task.title, "A valid objective");
  assert.equal(api.modelCalls.length, 0, "creating without start never calls the model");
});

test("a task runs end to end: plan, execute, independently verify, complete", async () => {
  const api = await makeApi({ script: plan([saveStep(), verifyStep()]) });
  const created = await api.call("POST", "/tasks", { objective: "Remember k1 and prove it", start: true });
  assert.equal(created.status, 201);
  const id = created.json.task.id;

  const done = await api.waitFor(id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed");
  assert.equal(done.verification.passed, true);
  assert.deepEqual(done.steps.map((s) => s.status), ["completed", "completed"]);
  assert.match(done.result.summary, /Objective achieved/);

  const events = (await api.call("GET", `/tasks/${id}/events`)).json.events;
  const types = events.map((e) => e.type);
  for (const expected of ["planning", "plan", "running", "step_started", "tool_result", "step_verified", "completed"]) {
    assert.ok(types.includes(expected), `event ${expected} in ${types.join(",")}`);
  }
  assert.ok(types.indexOf("plan") < types.indexOf("step_started") && types.indexOf("step_started") < types.indexOf("completed"));
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "event sequence numbers are contiguous");

  const memory = JSON.parse(fs.readFileSync(path.join(api.dir, "task-memory.json"), "utf8"));
  assert.equal(memory[0].key, "k1");
});

test("list: summary view is small and consistent with the full records", async () => {
  const api = await makeApi({ script: plan([saveStep(), verifyStep()]) });
  const a = (await api.call("POST", "/tasks", { objective: "first", start: true })).json.task.id;
  const b = (await api.call("POST", "/tasks", { objective: "second (not started)" })).json.task.id;
  await api.waitFor(a, "completed");

  const full = (await api.call("GET", "/tasks")).json.tasks;
  const summary = (await api.call("GET", "/tasks?view=summary")).json.tasks;
  assert.equal(full.length, 2);
  assert.equal(summary.length, 2);
  assert.ok(full[0].events && full[0].steps, "the default list keeps returning full records (backwards compatible)");
  for (const s of summary) {
    assert.equal(s.events, undefined);
    assert.equal(s.steps, undefined);
    const f = full.find((t) => t.id === s.id);
    assert.equal(s.status, f.status);
    assert.equal(s.stepsTotal, f.steps.length);
    assert.equal(s.stepsCompleted, f.steps.filter((x) => x.status === "completed").length);
  }
  const done = summary.find((s) => s.id === a);
  assert.equal(done.stepsCompleted, 2);
  assert.equal(done.verificationPassed, true);
  assert.equal(done.pendingApprovals, 0);
  assert.equal(done.hasRecovery, false);
  assert.equal(summary.find((s) => s.id === b).status, "queued");
});

test("planning failure is reported as failed with a reason, never as success", async () => {
  const api = await makeApi({ script: "I'm sorry, here is a poem instead of JSON." });
  const id = (await api.call("POST", "/tasks", { objective: "Do something", start: true })).json.task.id;
  const t = await api.waitFor(id, ["failed", "completed"]);
  assert.equal(t.status, "failed");
  assert.equal(t.error.stage, "planning");
  assert.deepEqual(t.steps, []);
  const summary = (await api.call("GET", "/tasks?view=summary")).json.tasks[0];
  assert.equal(summary.error.stage, "planning");
  assert.ok(summary.error.reason.length > 0);
});

test("an unavailable reasoning provider fails the task honestly", async () => {
  const api = await makeApi({ script: () => { throw new Error("No permitted free reasoning provider is configured."); } });
  const id = (await api.call("POST", "/tasks", { objective: "Anything", start: true })).json.task.id;
  const t = await api.waitFor(id, ["failed", "completed"]);
  assert.equal(t.status, "failed");
  assert.equal(t.error.stage, "planning", "classified as a planning failure, not an internal fault");
  assert.match(t.error.reason, /No permitted free reasoning provider/);
  assert.ok(t.events.some((e) => e.type === "failed" && /Planning could not run/.test(e.message)));
  assert.deepEqual(t.steps, []);
});

test("a plan that invents a tool is rejected and nothing runs", async () => {
  const api = await makeApi({
    script: plan([{ id: "s1", intent: "Delete everything", kind: "tool", tool: "run_shell", args: { cmd: "rm -rf /" }, dependsOn: [], verification: { method: "state_check" } }]),
  });
  const id = (await api.call("POST", "/tasks", { objective: "Do bad things", start: true })).json.task.id;
  const t = await api.waitFor(id, ["failed", "completed"]);
  assert.equal(t.status, "failed");
  assert.equal(t.error.stage, "planning");
  assert.match(JSON.stringify(t.error.details), /not a registered capability/);
});

/* ------------------------------- approvals ------------------------------- */

function sensitiveTool(counter) {
  return {
    name: "test_sensitive",
    description: "Test-only sensitive operation.",
    inputSchema: { type: "object", properties: { key: { type: "string", minLength: 1 }, value: { type: "string", minLength: 1 } }, required: ["key", "value"] },
    capabilities: ["test"],
    risk: "sensitive",
    approvalRequired: true,
    available: () => true,
    async execute(args, ctx) {
      counter.n++;
      ctx.recordMemoryNote(args.key, args.value);
      return { ok: true, output: "sensitive op done", verificationEvidence: { verified: true, source: "test read-back" } };
    },
  };
}
const sensitiveStep = () => ({
  id: "s1", intent: "Do the sensitive thing", kind: "tool", tool: "test_sensitive", args: { key: "k1", value: "v1" },
  dependsOn: [], expectedOutput: "done", verification: { method: "state_check" },
});

test("approval: a sensitive tool does not run until approved; the one-time token is single use", async () => {
  const counter = { n: 0 };
  const api = await makeApi({ script: plan([sensitiveStep(), verifyStep()]), extraTools: [sensitiveTool(counter)] });
  const id = (await api.call("POST", "/tasks", { objective: "Needs approval", start: true })).json.task.id;

  const waiting = await api.waitFor(id, ["waiting_approval", "failed", "completed"]);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(counter.n, 0, "sensitive tool has NOT executed while waiting");
  const approval = waiting.approvals[0];
  assert.equal(approval.decision, null);
  assert.equal(approval.tool, "test_sensitive");
  assert.match(waiting.steps[0].approval.summary, /test_sensitive/);
  assert.equal(JSON.stringify(waiting).includes("tokenHash"), false);

  const challenge = await api.call("GET", `/tasks/${id}/approval-challenge?requestId=${approval.requestId}`);
  assert.equal(challenge.status, 200);
  assert.ok(challenge.json.token.length >= 32);
  assert.equal((await api.call("GET", `/tasks/${id}/approval-challenge?requestId=${approval.requestId}`)).status, 404, "token can be taken once");
  assert.equal((await api.call("GET", `/tasks/${id}/approval-challenge`)).status, 400);

  const approved = await api.call("POST", `/tasks/${id}/approve`, { requestId: approval.requestId, token: challenge.json.token, approved: true });
  assert.equal(approved.status, 200);
  const replay = await api.call("POST", `/tasks/${id}/approve`, { requestId: approval.requestId, token: challenge.json.token, approved: true });
  assert.equal(replay.status, 409, "an answered approval cannot be answered again");

  const done = await api.waitFor(id, ["completed", "failed"]);
  assert.equal(done.status, "completed");
  assert.equal(counter.n, 1, "executed exactly once, after approval");
  assert.ok(done.events.some((e) => e.type === "approval" && /APPROVED/.test(e.message)));
});

test("approval: a wrong token is refused and the sensitive tool never runs", async () => {
  const counter = { n: 0 };
  const api = await makeApi({ script: plan([sensitiveStep(), verifyStep()]), extraTools: [sensitiveTool(counter)] });
  const id = (await api.call("POST", "/tasks", { objective: "Needs approval", start: true })).json.task.id;
  const waiting = await api.waitFor(id, "waiting_approval");
  const requestId = waiting.approvals[0].requestId;

  const bad = await api.call("POST", `/tasks/${id}/approve`, { requestId, token: "not-the-token", approved: true });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error, /Invalid approval token/);
  const missing = await api.call("POST", `/tasks/${id}/approve`, { requestId, approved: true });
  assert.equal(missing.status, 403);
  const unknown = await api.call("POST", `/tasks/${id}/approve`, { requestId: "nope", token: "x", approved: true });
  assert.equal(unknown.status, 404);
  assert.equal((await api.call("GET", `/tasks/${id}`)).json.task.status, "waiting_approval");
  assert.equal(counter.n, 0);

  const cancelled = await api.call("POST", `/tasks/${id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  const t = await api.waitFor(id, ["cancelled"]);
  assert.equal(t.status, "cancelled");
  assert.equal(counter.n, 0);
});

test("approval: refusing skips the step and the sensitive tool never runs", async () => {
  const counter = { n: 0 };
  const api = await makeApi({ script: plan([sensitiveStep(), verifyStep()]), extraTools: [sensitiveTool(counter)] });
  const id = (await api.call("POST", "/tasks", { objective: "Needs approval", start: true })).json.task.id;
  const waiting = await api.waitFor(id, "waiting_approval");
  const requestId = waiting.approvals[0].requestId;
  const { token } = (await api.call("GET", `/tasks/${id}/approval-challenge?requestId=${requestId}`)).json;
  const refused = await api.call("POST", `/tasks/${id}/approve`, { requestId, token, approved: false });
  assert.equal(refused.status, 200);

  const done = await api.waitFor(id, ["completed", "failed"]);
  assert.equal(counter.n, 0, "refused operation was never executed");
  assert.equal(done.steps[0].status, "skipped");
  assert.equal(done.status, "failed", "a refused step cannot be verified, so the task does not claim success");
  assert.ok(done.events.some((e) => e.type === "step_skipped" && /refused/.test(e.message)));
});

test("approval: a non-boolean 'approved' value is treated as a refusal, not an approval", async () => {
  const counter = { n: 0 };
  const api = await makeApi({ script: plan([sensitiveStep(), verifyStep()]), extraTools: [sensitiveTool(counter)] });
  const id = (await api.call("POST", "/tasks", { objective: "Needs approval", start: true })).json.task.id;
  const waiting = await api.waitFor(id, "waiting_approval");
  const requestId = waiting.approvals[0].requestId;
  const { token } = (await api.call("GET", `/tasks/${id}/approval-challenge?requestId=${requestId}`)).json;
  await api.call("POST", `/tasks/${id}/approve`, { requestId, token, approved: "true" });
  await api.waitFor(id, ["completed", "failed"]);
  assert.equal(counter.n, 0);
});

/* ------------------------- pause / resume / cancel ------------------------- */

function slowTool(log) {
  return {
    name: "slow_step",
    description: "Test-only slow safe tool.",
    inputSchema: { type: "object", properties: { label: { type: "string", minLength: 1 }, ms: { type: "integer", minimum: 0, maximum: 5000 } }, required: ["label", "ms"] },
    capabilities: ["test"],
    risk: "safe",
    approvalRequired: false,
    available: () => true,
    async execute(args) {
      log.push(`start:${args.label}`);
      await sleep(args.ms);
      log.push(`end:${args.label}`);
      return { ok: true, output: `slow ${args.label} done` };
    },
  };
}
const slowSteps = (n, ms) => [
  ...Array.from({ length: n }, (_, i) => ({
    id: `w${i + 1}`, intent: `Work ${i + 1}`, kind: "tool", tool: "slow_step", args: { label: `w${i + 1}`, ms },
    dependsOn: i === 0 ? [] : [`w${i}`], expectedOutput: "done", verification: { method: "output_present" },
  })),
  { id: "s1", intent: "Save", kind: "tool", tool: "save_memory_note", args: { key: "k1", value: "v1" }, dependsOn: [`w${n}`], expectedOutput: "saved", verification: { method: "output_present" } },
  verifyStep(["s1"]),
];

test("pause stops between steps, resume continues without redoing finished work", async () => {
  const log = [];
  const api = await makeApi({ script: plan(slowSteps(3, 250)), extraTools: [slowTool(log)] });
  const id = (await api.call("POST", "/tasks", { objective: "Slow work", start: true })).json.task.id;
  await api.waitFor(id, "running");
  await sleep(100);
  const pausing = await api.call("POST", `/tasks/${id}/pause`, {});
  assert.equal(pausing.status, 200);

  const paused = await api.waitFor(id, ["paused", "completed", "failed"]);
  assert.equal(paused.status, "paused");
  assert.ok(paused.events.some((e) => e.type === "paused"));
  const startedBefore = log.filter((l) => l.startsWith("start:")).length;
  assert.ok(startedBefore >= 1 && startedBefore < 3, `paused part-way (${startedBefore} of 3 started)`);
  await sleep(400);
  assert.equal(log.filter((l) => l.startsWith("start:")).length, startedBefore, "no work happens while paused");

  const resumed = await api.call("POST", `/tasks/${id}/resume`, {});
  assert.equal(resumed.status, 200);
  const done = await api.waitFor(id, ["completed", "failed"]);
  assert.equal(done.status, "completed");
  for (const label of ["w1", "w2", "w3"]) {
    assert.equal(log.filter((l) => l === `end:${label}`).length, 1, `${label} finished exactly once`);
  }
  assert.ok(done.events.some((e) => e.type === "running" && /resumed/i.test(e.message)));
});

test("cancel stops a running task and no further steps start", async () => {
  const log = [];
  const api = await makeApi({ script: plan(slowSteps(4, 250)), extraTools: [slowTool(log)] });
  const id = (await api.call("POST", "/tasks", { objective: "Slow work", start: true })).json.task.id;
  await api.waitFor(id, "running");
  await sleep(100);
  assert.equal((await api.call("POST", `/tasks/${id}/cancel`, {})).status, 200);
  const t = await api.waitFor(id, ["cancelled", "completed", "failed"]);
  assert.equal(t.status, "cancelled");
  const started = log.filter((l) => l.startsWith("start:")).length;
  await sleep(600);
  assert.equal(log.filter((l) => l.startsWith("start:")).length, started, "nothing starts after cancellation");
  assert.ok(started < 4);
});

test("invalid control requests are refused with clear status codes", async () => {
  const api = await makeApi({ script: plan([saveStep(), verifyStep()]) });
  const queued = (await api.call("POST", "/tasks", { objective: "Never started" })).json.task.id;

  assert.equal((await api.call("POST", `/tasks/${queued}/pause`, {})).status, 409, "a queued task cannot be paused");
  const cancelled = await api.call("POST", `/tasks/${queued}/cancel`, {});
  assert.equal(cancelled.json.task.status, "cancelled");
  assert.equal((await api.call("POST", `/tasks/${queued}/start`, {})).status, 409);
  assert.equal((await api.call("POST", `/tasks/${queued}/resume`, {})).status, 409);
  assert.equal((await api.call("POST", `/tasks/${queued}/pause`, {})).status, 409);
  assert.equal((await api.call("POST", `/tasks/${queued}/cancel`, {})).status, 200, "cancelling a finished task is a harmless no-op");
  assert.equal((await api.call("POST", `/tasks/unknown-task-id/cancel`, {})).status, 404);
  assert.equal((await api.call("POST", `/tasks/unknown-task-id/start`, {})).status, 404);
});

/* -------------------------------- recovery -------------------------------- */

test("restart recovery: interrupted tasks come back paused, never auto-run, and uncertain steps are not replayed", async () => {
  const counter = { n: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-task-recover-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const crashed = new TaskStore(dir);
  crashed.create({
    id: "crashed-task-1", title: "Interrupted", objective: "Was running when the app closed", status: "running",
    plan: { planId: "p", title: "t", summary: "s", steps: [] },
    steps: [{
      id: "s1", intent: "Do the sensitive thing", kind: "tool", tool: "test_sensitive", args: { key: "k", value: "v" },
      dependsOn: [], status: "running", attempts: [], recoveryNotes: [], verification: { method: "state_check" }, requiresApproval: true,
    }],
    approvals: [], events: [{ seq: 1, at: new Date().toISOString(), type: "running", message: "Executing plan." }],
  });

  // What task-api.mjs does at start-up:
  const store = new TaskStore(dir);
  const recovered = store.recoverInterrupted();
  assert.equal(recovered.length, 1);

  const registry = new ToolRegistry([...TOOL_DEFINITIONS, sensitiveTool(counter)]);
  const orchestrator = new TaskOrchestrator({ store, registry, gateway: new PermissionGateway(), callModel: async () => "{}" });
  const handler = createTaskApiHandler({ store, orchestrator, registry, plannerStatus: () => ({ configured: false, providers: [], permitted: [] }) });
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, "http://127.0.0.1")))) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const get = async (p, opts) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`, opts)).json();

  const after = (await get("/tasks/crashed-task-1")).task;
  assert.equal(after.status, "paused");
  assert.match(after.recovery.note, /interrupted by a server restart/);
  assert.equal(after.steps[0].uncertainSideEffects, true);
  assert.ok(after.events.some((e) => e.type === "recovery"));
  const summary = (await get("/tasks?view=summary")).tasks[0];
  assert.equal(summary.hasRecovery, true);
  assert.equal(summary.status, "paused");
  await sleep(300);
  assert.equal(counter.n, 0, "nothing ran automatically after the restart");

  await get("/tasks/crashed-task-1/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const end = Date.now() + 8000;
  let final;
  while (Date.now() < end) {
    final = (await get("/tasks/crashed-task-1")).task;
    if (final.status === "failed") break;
    await sleep(25);
  }
  assert.equal(final.status, "failed");
  assert.equal(counter.n, 0, "the uncertain operation was NOT replayed on resume");
  assert.ok(final.events.some((e) => e.type === "uncertain_side_effect_blocked"));
});

/* ------------------------------ capabilities ------------------------------ */

test("capabilities endpoint reports real tool availability and the planner state", async () => {
  const api = await makeApi({ script: "" });
  const r = await api.call("GET", "/tasks/capabilities");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.planner, { configured: true, providers: ["test"], permitted: ["test"] });
  assert.equal(r.json.limits.maxSteps, 12);
  const byName = Object.fromEntries(r.json.tools.map((t) => [t.name, t]));
  assert.equal(byName.provider_health.available, true);
  assert.equal(byName.save_memory_note.available, true);
  assert.equal(byName.send_whatsapp_message.available, false, "WhatsApp is not connected in this process");
  assert.equal(byName.send_whatsapp_message.approvalRequired, true);
  assert.equal(byName.send_whatsapp_message.risk, "sensitive");
  assert.equal(r.json.tools.every((t) => typeof t.available === "boolean"), true);
  assert.equal(r.json.tools.some((t) => "execute" in t || "inputSchema" in t), false, "no implementation details leak");
});

test("default instance: capabilities report which provider is configured but never leak keys", async () => {
  const saved = { o: process.env.OPENROUTER_API_KEY, g: process.env.GEMINI_API_KEY, f: process.env.EXILE_GEMINI_FREE_TIER };
  const secret = "sk-or-v1-SUPERSECRETVALUE1234567890";
  try {
    const run = async () => {
      const server = http.createServer(async (req, res) => { if (!(await handleTaskApi(req, res, new URL(req.url, "http://127.0.0.1")))) res.writeHead(404).end(); });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const res = await fetch(`http://127.0.0.1:${server.address().port}/tasks/capabilities`);
      const text = await res.text();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      return { status: res.status, text, json: JSON.parse(text) };
    };

    delete process.env.OPENROUTER_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.EXILE_GEMINI_FREE_TIER;
    const none = await run();
    assert.equal(none.json.planner.configured, false);
    assert.deepEqual(none.json.planner.providers, []);

    process.env.OPENROUTER_API_KEY = secret;
    const withKey = await run();
    assert.equal(withKey.json.planner.configured, true);
    assert.deepEqual(withKey.json.planner.providers, ["openrouter"]);
    assert.equal(withKey.text.includes(secret), false);

    process.env.GEMINI_API_KEY = "AIzaSyFAKEKEYFAKEKEYFAKEKEY12345";
    const gated = await run();
    assert.deepEqual(gated.json.planner.providers, ["openrouter"], "Gemini is ignored unless the free-tier flag is set");
    process.env.EXILE_GEMINI_FREE_TIER = "true";
    const both = await run();
    assert.deepEqual(both.json.planner.providers, ["gemini", "openrouter"]);
    assert.equal(both.text.includes("AIzaSy"), false);
  } finally {
    for (const [k, v] of [["OPENROUTER_API_KEY", saved.o], ["GEMINI_API_KEY", saved.g], ["EXILE_GEMINI_FREE_TIER", saved.f]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("secrets typed into an objective are redacted from stored and returned task data", async () => {
  const api = await makeApi({ script: "" });
  const created = await api.call("POST", "/tasks", { objective: "use key sk-abcdefghijklmnopqrstuvwxyz and AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  const id = created.json.task.id;
  const fetched = (await api.call("GET", `/tasks/${id}`)).json.task;
  assert.equal(JSON.stringify(fetched).includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(JSON.stringify(fetched).includes("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.match(fetched.objective, /\[redacted\]/);
  const onDisk = fs.readFileSync(path.join(api.dir, "tasks", `${id}.json`), "utf8") + fs.readFileSync(path.join(api.dir, "tasks-index.json"), "utf8");
  assert.equal(onDisk.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
});
