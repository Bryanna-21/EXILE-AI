// Phase 1 hardening: authenticated API, approval revocation, interruptible execution,
// idempotent side effects, honest verification, and corruption-safe persistence.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-hardening-default-"));
process.env.EXILE_TASK_STORE_DIR = dataDir;
const { createTaskApiHandler, handleTaskApi, parseCreateBody, parseApproveBody } = await import("../local/task-api.mjs");
const { TaskStore, validateTaskRecord, sanitizeValue, StoredRecordCorruptError } = await import("../local/task-store.mjs");
const { ToolRegistry, DEFAULT_TOOL_TIMEOUT_MS } = await import("../local/tool-registry.mjs");
const { PermissionGateway } = await import("../local/permission-gateway.mjs");
const { TaskOrchestrator, isMeaningfulOutput } = await import("../local/task-orchestrator.mjs");
const { validatePlan } = await import("../local/task-planner.mjs");
const { localAuth, createLocalAuth, checkLocalRequest, AUTH_HEADER } = await import("../local/local-auth.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [dataDir];
const tmp = (label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `exile-${label}-`)); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ API auth */

async function withServer(handler, fn) {
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, "http://127.0.0.1")))) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test("API: requests without the launch secret are refused (401), wrong secret too, correct secret works", async () => {
  await withServer(handleTaskApi, async (base) => {
    assert.equal((await fetch(`${base}/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/tasks`, { headers: { [AUTH_HEADER]: "x".repeat(40) } })).status, 401);
    assert.equal((await fetch(`${base}/tasks`, { headers: { [AUTH_HEADER]: "" } })).status, 401);
    const ok = await fetch(`${base}/tasks`, { headers: { [AUTH_HEADER]: localAuth.secret } });
    assert.equal(ok.status, 200);
  });
});

test("API: the approval-challenge route (which hands out approval tokens) needs the secret", async () => {
  await withServer(handleTaskApi, async (base) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const anon = await fetch(`${base}/tasks/abcdef12/approval-challenge?requestId=${id}`);
    assert.equal(anon.status, 401);
    assert.ok(!/token/i.test(await anon.text()));
  });
});

test("API: foreign web origins are refused even with the right secret; no wildcard CORS", async () => {
  await withServer(handleTaskApi, async (base) => {
    const evil = await fetch(`${base}/tasks`, { headers: { [AUTH_HEADER]: localAuth.secret, Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const local = await fetch(`${base}/tasks`, { headers: { [AUTH_HEADER]: localAuth.secret, Origin: "http://localhost:8080" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:8080");
  });
});

test("API: DNS-rebinding style Host headers are refused", () => {
  const auth = createLocalAuth("s".repeat(40));
  const req = (host) => ({ headers: { host, [AUTH_HEADER]: auth.secret } });
  assert.equal(checkLocalRequest(req("127.0.0.1:8787"), auth), null);
  assert.equal(checkLocalRequest(req("localhost:8787"), auth), null);
  assert.equal(checkLocalRequest(req("evil.example:8787"), auth)?.status, 403);
  assert.equal(checkLocalRequest(req("127.0.0.1.evil.example"), auth)?.status, 403);
});

test("local auth: short supplied secrets are replaced by a random one; supplied long secrets are used", () => {
  assert.notEqual(createLocalAuth("short").secret, "short");
  assert.equal(createLocalAuth("s".repeat(40)).secret, "s".repeat(40));
  assert.equal(createLocalAuth("s".repeat(40)).suppliedByLauncher, true);
  assert.equal(createLocalAuth("s".repeat(40)).verify({ headers: { [AUTH_HEADER]: "t".repeat(40) } }), false);
});

test("API: request schemas are validated strictly", () => {
  assert.throws(() => parseCreateBody({ objective: 5 }), /objective/);
  assert.throws(() => parseCreateBody({ objective: "x", start: "yes" }), /start/);
  assert.throws(() => parseCreateBody({ objective: "x", title: 1 }), /title/);
  assert.throws(() => parseCreateBody([]), /object/);
  assert.deepEqual(parseCreateBody({ objective: "go", start: true }), { objective: "go", title: undefined, start: true });
  assert.throws(() => parseApproveBody({ requestId: "../x", token: "t", approved: true }), /requestId/);
  const ok = parseApproveBody({ requestId: "11111111-1111-4111-8111-111111111111", token: "tok", approved: "true" });
  assert.equal(ok.approved, false, "only a literal true approves");
});

test("API: malformed task ids are rejected before touching storage", async () => {
  await withServer(handleTaskApi, async (base) => {
    const h = { [AUTH_HEADER]: localAuth.secret };
    for (const bad of ["..%2F..%2Fetc", "a", "x".repeat(80), "%E0%A4%A"]) {
      const r = await fetch(`${base}/tasks/${bad}`, { headers: h });
      assert.equal(r.status, 400, bad);
    }
  });
});

/* ------------------------------------------------------------- approval gateway */

const approvalArgs = { taskId: "t-123456", stepId: "s1", tool: "send_x", args: { to: "a", text: "b" }, risk: "sensitive" };

function approve(gw, over = {}) {
  const created = gw.createRequest(approvalArgs);
  const decided = gw.decide({ requestId: created.requestId, token: created.token, approved: true, taskId: approvalArgs.taskId, stepId: "s1", tool: "send_x", args: approvalArgs.args, ...over });
  return { created, decided };
}
const exec = (gw, requestId, over = {}) => gw.authorizeExecution({ requestId, taskId: approvalArgs.taskId, stepId: "s1", tool: "send_x", args: approvalArgs.args, ...over });

test("approvals: a revoked approval can never authorize execution", () => {
  const gw = new PermissionGateway();
  const { created, decided } = approve(gw);
  assert.equal(decided.ok, true);
  assert.equal(gw.revoke(created.requestId, "operator changed their mind").ok, true);
  const r = exec(gw, created.requestId);
  assert.equal(r.allowed, false);
  assert.match(r.error, /revoked/);
});

test("approvals: revoking a pending request blocks the later decision", () => {
  const gw = new PermissionGateway();
  const created = gw.createRequest(approvalArgs);
  gw.revoke(created.requestId);
  const d = gw.decide({ requestId: created.requestId, token: created.token, approved: true, taskId: "t-123456", stepId: "s1", tool: "send_x", args: approvalArgs.args });
  assert.equal(d.ok, false);
  assert.match(d.error, /revoked/);
});

test("approvals: revokeForTask withdraws all unused grants of that task only", () => {
  const gw = new PermissionGateway();
  const a = approve(gw).created;
  const other = gw.createRequest({ ...approvalArgs, taskId: "t-other-1" });
  assert.equal(gw.revokeForTask("t-123456", "cancelled"), 1);
  assert.equal(exec(gw, a.requestId).allowed, false);
  assert.equal(gw.getRequest(other.requestId).decision, null);
});

test("approvals: expiry is enforced for decisions and for execution (injected clock)", () => {
  let now = 1_000_000;
  const gw = new PermissionGateway({ ttlMs: 1000, now: () => now });
  const created = gw.createRequest(approvalArgs);
  now += 1500;
  const late = gw.decide({ requestId: created.requestId, token: created.token, approved: true, taskId: "t-123456", stepId: "s1", tool: "send_x", args: approvalArgs.args });
  assert.equal(late.ok, false);
  assert.match(late.error, /expired/i);
  now = 2_000_000;
  const { created: c2 } = approve(gw);
  now += 1500;
  assert.match(exec(gw, c2.requestId).error, /expired/i);
});

test("approvals: grants are single-use and bound to task, step, tool and exact arguments", () => {
  const gw = new PermissionGateway();
  const { created } = approve(gw);
  assert.equal(exec(gw, created.requestId, { taskId: "t-other-1" }).allowed, false);
  assert.equal(exec(gw, created.requestId, { stepId: "s2" }).allowed, false);
  assert.equal(exec(gw, created.requestId, { tool: "other_tool" }).allowed, false);
  assert.equal(exec(gw, created.requestId, { args: { to: "a", text: "CHANGED" } }).allowed, false);
  assert.equal(exec(gw, created.requestId).allowed, true);
  assert.equal(exec(gw, created.requestId).allowed, false, "second use is refused");
});

test("approvals: tokens never appear in stored or listed approval data", () => {
  const gw = new PermissionGateway();
  const created = gw.createRequest(approvalArgs);
  const json = JSON.stringify([gw.getRequest(created.requestId), gw.pendingForTask("t-123456")]);
  assert.ok(!json.includes(created.token));
  assert.ok(!json.includes("tokenHash"));
});

test("approvals: reserved keys in arguments are rejected rather than silently dropped from the hash", () => {
  const poisoned = JSON.parse('{"to":"a","__proto__":{"admin":true}}');
  assert.throws(() => PermissionGateway.hashArgs(poisoned), /reserved/);
});

/* ------------------------------------------------------------------- registry */

const tool = (name, over = {}) => ({ name, description: name, inputSchema: { type: "object", properties: {}, required: [] }, capabilities: [], risk: "safe", approvalRequired: false, available: () => true, execute: async () => ({ ok: true, output: "fine output" }), ...over });

test("registry: a hung tool is cut off at its time budget", async () => {
  const reg = new ToolRegistry([tool("hang", { timeoutMs: 60, execute: () => new Promise(() => {}) })]);
  const t0 = Date.now();
  const r = await reg.invoke("hang", {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(DEFAULT_TOOL_TIMEOUT_MS > 0);
});

test("registry: aborting the signal interrupts a running tool and reaches the adapter", async () => {
  let seen = null;
  const reg = new ToolRegistry([tool("slow", { risk: "reversible", execute: (_a, ctx) => new Promise((res) => { seen = ctx.signal; setTimeout(() => res({ ok: true, output: "late" }), 2000); }) })]);
  const ac = new AbortController();
  const p = reg.invoke("slow", {}, { signal: ac.signal });
  await sleep(30);
  ac.abort(new Error("stop"));
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.started, true);
  assert.equal(r.risk, "reversible");
  assert.equal(seen.aborted, true, "adapter receives an aborted signal so it can cancel its own I/O");
});

test("registry: an approval is not consumed when the call is invalid, unavailable or already aborted", async () => {
  let consumed = 0;
  const ctx = (extra = {}) => ({ authorizeExecution: () => { consumed++; return { allowed: true }; }, ...extra });
  const schema = { type: "object", properties: { to: { type: "string", minLength: 1 } }, required: ["to"] };
  const reg = new ToolRegistry([
    tool("send", { risk: "sensitive", approvalRequired: true, inputSchema: schema }),
    tool("offline", { risk: "sensitive", approvalRequired: true, available: () => false }),
  ]);
  await reg.invoke("send", {}, ctx());
  await reg.invoke("offline", {}, ctx());
  const ac = new AbortController(); ac.abort();
  await reg.invoke("send", { to: "a" }, ctx({ signal: ac.signal }));
  assert.equal(consumed, 0);
  assert.equal((await reg.invoke("send", { to: "a" }, ctx())).ok, true);
  assert.equal(consumed, 1);
});

/* --------------------------------------------------------------- orchestrator */

function engine(defs, { script, limits } = {}) {
  const dir = tmp("engine");
  const store = new TaskStore(dir);
  const registry = new ToolRegistry(defs);
  const gateway = new PermissionGateway();
  const calls = [];
  const orchestrator = new TaskOrchestrator({
    store, registry, gateway,
    callModel: async (messages, opts) => { calls.push(opts); return typeof script === "function" ? script(messages, opts) : script; },
    limits: { taskTimeoutMs: 5000, ...(limits ?? {}) },
  });
  return { dir, store, registry, gateway, orchestrator, calls };
}
const plan = (steps) => JSON.stringify({ title: "t", summary: "s", steps, blockedCapabilities: [] });
const verifyDef = tool("verify_it", { execute: async () => ({ ok: true, output: "verified", verificationEvidence: { verified: true, source: "unit-test read-back" } }) });
const finalStep = (dependsOn) => ({ id: "v", intent: "verify", kind: "verification", tool: "verify_it", args: {}, dependsOn, expectedOutput: "ok", verification: { method: "state_check", criteria: "" } });
const toolStep = (id, name, extra = {}) => ({ id, intent: id, kind: "tool", tool: name, args: {}, dependsOn: [], expectedOutput: "", verification: { method: "output_present", criteria: "" }, ...extra });
async function waitStatus(store, id, statuses, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = store.get(id); if (statuses.includes(t.status)) return t; await sleep(20); }
  throw new Error(`timed out waiting for ${statuses}; now ${store.get(id).status}`);
}

test("cancel interrupts a hung tool promptly and marks non-safe work as uncertain", async () => {
  const hang = tool("hang_write", { risk: "reversible", timeoutMs: 60_000, execute: () => new Promise(() => {}) });
  const e = engine([hang, verifyDef], { script: plan([toolStep("s1", "hang_write"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "do the thing" });
  await e.orchestrator.startOrResume(task.id);
  await waitStatus(e.store, task.id, ["running"]);
  await sleep(150);
  const t0 = Date.now();
  e.orchestrator.requestCancel(task.id);
  const done = await waitStatus(e.store, task.id, ["cancelled", "failed", "completed"], 2000);
  assert.equal(done.status, "cancelled");
  assert.ok(Date.now() - t0 < 1500, "did not wait for the hung tool");
  const s1 = done.steps.find((s) => s.id === "s1");
  assert.equal(s1.uncertainSideEffects, true, "an interrupted non-safe operation is never silently replayed");
  assert.equal(e.orchestrator.active.size, 0);
});

test("task timeout interrupts a hung tool instead of waiting for it", async () => {
  const hang = tool("hang_safe", { timeoutMs: 60_000, execute: () => new Promise(() => {}) });
  const e = engine([hang, verifyDef], { script: plan([toolStep("s1", "hang_safe"), finalStep(["s1"])]), limits: { taskTimeoutMs: 250 } });
  const task = e.orchestrator.createTask({ objective: "slow thing" });
  const t0 = Date.now();
  await e.orchestrator.startOrResume(task.id);
  const done = await waitStatus(e.store, task.id, ["failed", "completed", "cancelled"], 3000);
  assert.equal(done.status, "failed");
  assert.equal(done.error.stage, "timeout");
  assert.ok(Date.now() - t0 < 2500);
});

test("a hung model call is interrupted by cancel", async () => {
  const e = engine([verifyDef], { script: () => new Promise(() => {}) });
  const task = e.orchestrator.createTask({ objective: "plan forever" });
  await e.orchestrator.startOrResume(task.id);
  await waitStatus(e.store, task.id, ["planning"]);
  e.orchestrator.requestCancel(task.id);
  const done = await waitStatus(e.store, task.id, ["cancelled", "failed"], 2000);
  assert.equal(done.status, "cancelled");
});

test("model calls receive an AbortSignal", async () => {
  const e = engine([verifyDef], { script: plan([finalStep([])]) });
  const task = e.orchestrator.createTask({ objective: "x" });
  await e.orchestrator.startOrResume(task.id);
  await waitStatus(e.store, task.id, ["completed", "failed"]);
  assert.ok(e.calls.length > 0 && e.calls.every((o) => o?.signal instanceof AbortSignal));
});

test("retries cannot duplicate reversible side effects (idempotency key)", async () => {
  let attempts = 0;
  const flaky = tool("flaky_note", {
    risk: "reversible",
    execute: async (_a, ctx) => {
      attempts++;
      ctx.recordMemoryNote("k", "v"); // side effect happens on every attempt...
      return attempts < 2 ? { ok: false, error: "transient", recoverable: true } : { ok: true, output: "saved note" };
    },
  });
  const e = engine([flaky, verifyDef], { script: plan([toolStep("s1", "flaky_note"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "save" });
  await e.orchestrator.startOrResume(task.id);
  const done = await waitStatus(e.store, task.id, ["completed", "failed"], 8000);
  assert.equal(done.status, "completed");
  assert.equal(attempts, 2);
  const notes = JSON.parse(fs.readFileSync(path.join(e.dir, "task-memory.json"), "utf8"));
  assert.equal(notes.filter((n) => n.key === "k").length, 1, "the note was written once despite two attempts");
});

test("verification: meaningless output does not pass; execution and verification are recorded separately", async () => {
  assert.equal(isMeaningfulOutput("null"), false);
  assert.equal(isMeaningfulOutput("{}"), false);
  assert.equal(isMeaningfulOutput("   "), false);
  assert.equal(isMeaningfulOutput("Saved 3 rows"), true);
  const nullTool = tool("returns_null", { execute: async () => ({ ok: true, output: "null" }) });
  const e = engine([nullTool, verifyDef], { script: plan([toolStep("s1", "returns_null"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "x" });
  await e.orchestrator.startOrResume(task.id);
  const done = await waitStatus(e.store, task.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  const s1 = done.steps.find((s) => s.id === "s1");
  assert.equal(s1.execution.ok, true, "the tool ran");
  assert.equal(s1.verificationResult.passed, false, "but it was not verified");
});

test("verification that times out is recorded as a failed verification, not a pass", async () => {
  const slowVerify = tool("verify_it", { timeoutMs: 50, execute: () => new Promise(() => {}) });
  const e = engine([tool("noop"), slowVerify], { script: plan([toolStep("s1", "noop"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "x" });
  await e.orchestrator.startOrResume(task.id);
  const done = await waitStatus(e.store, task.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  const v = done.steps.find((s) => s.id === "v");
  assert.equal(v.verificationResult.passed, false);
  assert.match(v.verificationResult.reason, /timed out/i);
  assert.equal(done.verification?.passed ?? false, false);
});

test("cancelling a task that waits for approval withdraws the pending approval", async () => {
  const send = tool("send_msg", { risk: "sensitive", approvalRequired: true });
  const e = engine([send, verifyDef], { script: plan([toolStep("s1", "send_msg"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "send" });
  await e.orchestrator.startOrResume(task.id);
  const waiting = await waitStatus(e.store, task.id, ["waiting_approval"]);
  const requestId = waiting.approvals[0].requestId;
  assert.equal(e.gateway.getRequest(requestId).decision, null);
  e.orchestrator.requestCancel(task.id);
  const done = await waitStatus(e.store, task.id, ["cancelled"], 3000);
  assert.equal(done.status, "cancelled");
  assert.equal(e.gateway.getRequest(requestId).decision, "revoked");
  assert.equal(e.gateway.authorizeExecution({ requestId, taskId: task.id, stepId: "s1", tool: "send_msg", args: {} }).allowed, false);
});

test("approval tokens never reach persisted task files, events or the audit log", async () => {
  let ran = 0;
  const send = tool("send_msg", { risk: "sensitive", approvalRequired: true, execute: async () => { ran++; return { ok: true, output: "sent", verificationEvidence: { verified: true, source: "unit read-back" } }; } });
  const e = engine([send, verifyDef], { script: plan([toolStep("s1", "send_msg"), finalStep(["s1"])]) });
  const task = e.orchestrator.createTask({ objective: "send" });
  await e.orchestrator.startOrResume(task.id);
  const waiting = await waitStatus(e.store, task.id, ["waiting_approval"]);
  const requestId = waiting.approvals[0].requestId;
  const token = e.orchestrator.takeApprovalChallenge(task.id, requestId);
  assert.ok(token && token.length > 20);
  assert.equal(e.orchestrator.takeApprovalChallenge(task.id, requestId), null, "a challenge is handed out once");
  await e.orchestrator.decideApproval({ taskId: task.id, requestId, token, approved: true });
  const done = await waitStatus(e.store, task.id, ["completed", "failed"], 6000);
  assert.equal(done.status, "completed");
  assert.equal(ran, 1);
  const everything = fs.readdirSync(e.dir, { recursive: true }).map(String).filter((f) => !fs.statSync(path.join(e.dir, f)).isDirectory()).map((f) => fs.readFileSync(path.join(e.dir, f), "utf8")).join("\n");
  assert.ok(!everything.includes(token), "plaintext token must not be persisted anywhere");
});

/* ------------------------------------------------------------------ planner */

const fakeRegistry = { catalog: () => [{ name: "a_tool" }, { name: "verify_it" }], validateCall: () => [], requiresApproval: () => false };
const vstep = (over = {}) => ({ id: "v", intent: "verify", kind: "verification", tool: "verify_it", args: {}, dependsOn: ["s1"], verification: { method: "state_check" }, ...over });
const sstep = (over = {}) => ({ id: "s1", intent: "act", kind: "tool", tool: "a_tool", args: {}, dependsOn: [], ...over });
const check = (steps) => validatePlan({ title: "t", summary: "s", steps }, fakeRegistry, "obj");

test("planner: self-dependencies, unknown dependencies and bad verification methods are rejected", () => {
  assert.match(check([sstep({ dependsOn: ["s1"] }), vstep()]).errors.join("|"), /cannot depend on itself/);
  assert.match(check([sstep({ dependsOn: ["nope"] }), vstep()]).errors.join("|"), /unknown step/);
  assert.match(check([sstep({ verification: { method: "trust_me" } }), vstep()]).errors.join("|"), /unsupported verification method/);
  assert.match(check([sstep({ verification: { method: "output_contains", criteria: "" } }), vstep()]).errors.join("|"), /criteria/);
  assert.match(check([sstep(), vstep({ verification: { method: "output_present" } })]).errors.join("|"), /state_check/);
});

test("planner: three-step dependency cycles and unregistered tools never reach the executor", () => {
  const cyc = check([sstep({ id: "a", dependsOn: ["c"] }), sstep({ id: "b", dependsOn: ["a"] }), sstep({ id: "c", dependsOn: ["b"] }), vstep({ dependsOn: ["c"] })]);
  assert.equal(cyc.ok, false);
  assert.match(cyc.errors.join("|"), /cycle/);
  assert.match(check([sstep({ tool: "rm_rf" }), vstep()]).errors.join("|"), /not a registered capability/);
});

test("planner: a plan using a prototype-polluting step id is handled safely", () => {
  const r = check([sstep({ id: "__proto__" }), vstep({ dependsOn: ["__proto__"] })]);
  assert.equal(({}).polluted, undefined);
  assert.equal(typeof r.ok, "boolean");
});

/* -------------------------------------------------------------------- store */

const baseRecord = (id, over = {}) => ({ id, title: "t", objective: "o", status: "queued", plan: null, steps: [], approvals: [], events: [], ...over });

test("store: a corrupt task file is quarantined and skipped; other tasks stay available", () => {
  const dir = tmp("store-corrupt");
  const store = new TaskStore(dir);
  store.create(baseRecord("good-task-1"));
  store.create(baseRecord("bad-task-01"));
  fs.writeFileSync(path.join(dir, "tasks", "bad-task-01.json"), "{not json");
  const listed = store.list();
  assert.deepEqual(listed.map((t) => t.id), ["good-task-1"]);
  assert.ok(store.integrityWarnings.some((w) => /bad-task-01/.test(w.file)));
  assert.ok(fs.readdirSync(path.join(dir, "tasks")).some((f) => f.includes(".corrupt-")), "kept for inspection, not deleted");
});

test("store: reading a corrupt task throws a clear corruption error", () => {
  const dir = tmp("store-corrupt2");
  const store = new TaskStore(dir);
  store.create(baseRecord("task-aaaa-1"));
  fs.writeFileSync(path.join(dir, "tasks", "task-aaaa-1.json"), JSON.stringify({ id: "task-aaaa-1", status: "bogus", objective: "x" }));
  assert.throws(() => store.get("task-aaaa-1"), (e) => e instanceof StoredRecordCorruptError && e.statusCode === 500);
});

test("store: a corrupt index is rebuilt from the task files when they exist", () => {
  const dir = tmp("store-index");
  const store = new TaskStore(dir);
  store.create(baseRecord("task-bbbb-1"));
  store.create(baseRecord("task-bbbb-2"));
  fs.writeFileSync(path.join(dir, "tasks-index.json"), "{broken");
  assert.deepEqual(store.list().map((t) => t.id).sort(), ["task-bbbb-1", "task-bbbb-2"]);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes("tasks-index.json.corrupt-")));
});

test("store: a task file whose id does not match its file name is refused", () => {
  const dir = tmp("store-mismatch");
  const store = new TaskStore(dir);
  store.create(baseRecord("task-cccc-1"));
  fs.writeFileSync(path.join(dir, "tasks", "task-cccc-1.json"), JSON.stringify(baseRecord("task-other-9")));
  assert.throws(() => store.get("task-cccc-1"), StoredRecordCorruptError);
});

test("store: invalid records cannot be saved; unsafe ids cannot address files", () => {
  const dir = tmp("store-valid");
  const store = new TaskStore(dir);
  assert.throws(() => store.create(baseRecord("task-dddd-1", { status: "exploded" })), /Invalid task record/);
  assert.throws(() => store.create(baseRecord("../../escape")), /Invalid/);
  assert.throws(() => store.get("../../etc/passwd"), /Invalid task id/);
  assert.deepEqual(validateTaskRecord(baseRecord("task-eeee-1", { steps: [{ id: "s", status: "weird" }] })).length, 1);
});

test("store: prototype-polluting keys are dropped before persistence and never pollute Object.prototype", () => {
  const dir = tmp("store-proto");
  const store = new TaskStore(dir);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"safe":"yes"}');
  assert.deepEqual(Object.keys(sanitizeValue(hostile)), ["safe"]);
  store.create(baseRecord("task-ffff-1", { result: hostile }));
  const back = store.get("task-ffff-1");
  assert.equal(back.result.safe, "yes");
  assert.equal(Object.keys(back.result).length, 1);
  assert.equal(({}).polluted, undefined);
});

test("store: secrets are redacted and files are private to the owner", () => {
  const dir = tmp("store-secret");
  const store = new TaskStore(dir);
  store.create(baseRecord("task-gggg-1", { result: { apiKey: "abc", note: "sk-or-v1-ABCDEFGHIJKLMNOPQRSTUV" } }));
  const raw = fs.readFileSync(path.join(dir, "tasks", "task-gggg-1.json"), "utf8");
  assert.ok(!raw.includes("ABCDEFGHIJKLMNOPQRSTUV"));
  assert.ok(raw.includes("[redacted]"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "tasks", "task-gggg-1.json")).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(dir, "tasks")).mode & 0o077, 0);
  }
});

test("store: concurrent writers in separate processes never corrupt the index", () => {
  const dir = tmp("store-concurrent");
  new TaskStore(dir);
  const script = `
    import { TaskStore } from ${JSON.stringify(new URL("../local/task-store.mjs", import.meta.url).href)};
    const s = new TaskStore(process.argv[1]);
    for (let i = 0; i < 15; i++) s.create({ id: process.argv[2] + "-task-" + i, title: "t", objective: "o", status: "queued", steps: [], approvals: [], events: [] });
  `;
  const { spawn } = await_free_spawn();
  return Promise.allSettled(["pa", "pb", "pc", "pd"].map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, tag], { stdio: "pipe" });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} failed: ${err}`))));
  }))).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");
    assert.deepEqual(failures, [], failures.map((failure) => failure.reason?.message).join("\\n"));
    const index = JSON.parse(fs.readFileSync(path.join(dir, "tasks-index.json"), "utf8"));
    assert.equal(index.length, 60);
    assert.equal(new Set(index.map((e) => e.id)).size, 60);
    assert.equal(fs.existsSync(path.join(dir, "tasks-index.lock")), false);
  });
});
function await_free_spawn() { return { spawn: (...a) => spawnSync && _spawn(...a) }; }
import { spawn as _spawn } from "node:child_process";

test("store: restart recovery pauses interrupted tasks and flags uncertain steps", () => {
  const dir = tmp("store-recover");
  const store = new TaskStore(dir);
  store.create(baseRecord("task-hhhh-1", { status: "running", steps: [{ id: "s1", status: "running", attempts: [] }] }));
  const recovered = store.recoverInterrupted();
  assert.equal(recovered.length, 1);
  const t = store.get("task-hhhh-1");
  assert.equal(t.status, "paused");
  assert.equal(t.steps[0].uncertainSideEffects, true);
  assert.equal(t.steps[0].status, "pending");
});
