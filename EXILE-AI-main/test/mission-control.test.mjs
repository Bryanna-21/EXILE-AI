import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";

const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-mc-default-"));
process.env.EXILE_TASK_STORE_DIR = defaultDir;

const { createTaskApiHandler } = await import("../local/task-api.mjs");
const { TaskStore } = await import("../local/task-store.mjs");
const { ToolRegistry, TOOL_DEFINITIONS } = await import("../local/tool-registry.mjs");
const { PermissionGateway } = await import("../local/permission-gateway.mjs");
const { TaskOrchestrator } = await import("../local/task-orchestrator.mjs");

const { createTaskClient } = await import("../src/lib/taskApi.ts");
const mc = await import("../src/lib/missionControl.ts");
const goalsLib = await import("../src/lib/goals.ts");
const apps = await import("../src/lib/nativeApps.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [() => fs.rmSync(defaultDir, { recursive: true, force: true })];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

/* ----------------------- real service behind a real client ----------------------- */

const plan = (steps) => JSON.stringify({ title: "Plan", summary: "Plan summary", steps, blockedCapabilities: [] });
const saveStep = { id: "s1", intent: "Save a note", kind: "tool", tool: "save_memory_note", args: { key: "k", value: "v" }, dependsOn: [], verification: { method: "output_present" } };
const verifyStep = { id: "v", intent: "Verify", kind: "verification", tool: "verify_memory_note", args: { key: "k", expectedValue: "v" }, dependsOn: ["s1"], verification: { method: "state_check" } };
const sensitive = (counter) => ({
  name: "test_sensitive", description: "Test sensitive tool.",
  inputSchema: { type: "object", properties: { key: { type: "string", minLength: 1 }, value: { type: "string", minLength: 1 } }, required: ["key", "value"] },
  capabilities: ["test"], risk: "sensitive", approvalRequired: true, available: () => true,
  async execute(args, ctx) { counter.n++; ctx.recordMemoryNote(args.key, args.value); return { ok: true, output: "done", verificationEvidence: { verified: true, source: "test" } }; },
});

async function boot({ script, tools = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-mc-"));
  const store = new TaskStore(dir);
  const registry = new ToolRegistry([...TOOL_DEFINITIONS, ...tools]);
  const orchestrator = new TaskOrchestrator({
    store, registry, gateway: new PermissionGateway(),
    callModel: async (m) => (/revise EXILE task plans/.test(m[0].content) ? '{"action":"abandon"}' : script),
  });
  const handler = createTaskApiHandler({ store, orchestrator, registry, plannerStatus: () => ({ configured: true, providers: ["test"], permitted: ["test"] }) });
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, "http://127.0.0.1")))) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = createTaskClient({ getBase: async () => base });
  const until = async (id, statuses, ms = 12000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      const r = await client.getTask(id);
      if (r.ok) { last = r.data; if (statuses.includes(last.status)) return last; }
      await sleep(25);
    }
    throw new Error(`timed out; last=${last?.status}`);
  };
  return { base, client, until, store };
}

test("client: full task lifecycle through the real service", async () => {
  const { client, until } = await boot({ script: plan([saveStep, verifyStep]) });
  const created = await client.createTask({ objective: "  Remember a thing  ", start: true });
  assert.equal(created.ok, true);
  assert.equal(created.data.objective, "Remember a thing");
  const done = await until(created.data.id, ["completed", "failed"]);
  assert.equal(done.status, "completed");

  const list = await client.listTasks();
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].steps, undefined, "list uses the lightweight summary view");
  assert.deepEqual(mc.progressOf(list.data[0]), { done: 2, total: 2, percent: 100, label: "2 of 2 steps" });
  assert.deepEqual(mc.summaryFromRecord(done), list.data[0], "client-side summary matches the server summary");

  const events = await client.getEvents(done.id);
  assert.equal(events.ok, true);
  const tl = mc.timelineOf(events.data, "oldest");
  assert.equal(tl[0].seq, 1);
  assert.equal(tl.at(-1).title, "Completed");
  assert.equal(mc.timelineOf(events.data, "newest")[0].title, "Completed");

  const caps = await client.getCapabilities();
  assert.equal(caps.ok, true);
  assert.equal(caps.data.planner.configured, true);
  assert.ok(caps.data.tools.some((t) => t.name === "save_memory_note" && t.available));
});

test("client: failures are classified, not flattened", async () => {
  const { client, base } = await boot({ script: plan([saveStep, verifyStep]) });

  const q = await client.createTask({ objective: "Never started" });
  assert.equal(q.ok, true);
  const conflict = await client.control(q.data.id, "pause");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.kind, "conflict");
  assert.match(conflict.message, /Invalid task state transition/);
  assert.equal((await client.control("no-such-task", "cancel")).kind, "not-found");
  assert.equal((await client.getTask("no-such-task")).kind, "not-found");

  assert.equal((await client.createTask({ objective: "   " })).kind, "invalid");
  const long = await client.createTask({ objective: "x".repeat(4001) });
  assert.equal(long.kind, "invalid");
  assert.match(long.message, /4000/);

  const evil = createTaskClient({ getBase: async () => base, fetchImpl: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), Origin: "https://evil.example" } }) });
  const forbidden = await evil.listTasks();
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.kind, "forbidden");
  assert.equal(forbidden.status, 403);

  const nowhere = createTaskClient({ getBase: async () => "" });
  assert.equal((await nowhere.listTasks()).kind, "disconnected");
  const throwing = createTaskClient({ getBase: async () => { throw new Error("boom"); } });
  assert.equal((await throwing.listTasks()).kind, "disconnected");

  const free = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  let redetects = 0;
  const closed = createTaskClient({ getBase: async () => `http://127.0.0.1:${free}`, onDisconnected: () => { redetects++; } });
  const down = await closed.listTasks();
  assert.equal(down.kind, "disconnected");
  assert.match(down.message, /Cannot reach EXILE's local task service/);
  assert.equal(redetects, 1, "the caller is told to re-detect the port");
});

test("client: a hung service becomes a timeout, and odd replies become 'malformed'", async () => {
  const hung = http.createServer(() => { /* never answers */ });
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => { hung.closeAllConnections?.(); hung.close(r); }));
  const slow = createTaskClient({ getBase: async () => `http://127.0.0.1:${hung.address().port}`, timeoutMs: 150 });
  const t0 = Date.now();
  const r = await slow.listTasks();
  assert.equal(r.kind, "timeout");
  assert.ok(Date.now() - t0 < 2000);

  const jsonOf = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const make = (impl) => createTaskClient({ getBase: async () => "http://x", fetchImpl: impl });
  assert.equal((await make(jsonOf(200, { ok: true })).listTasks()).kind, "malformed");
  assert.equal((await make(jsonOf(200, "<html>proxy page</html>")).listTasks()).kind, "malformed");
  assert.equal((await make(jsonOf(200, { ok: false, tasks: [] })).listTasks()).kind, "malformed");
  assert.equal((await make(jsonOf(200, { ok: true, tasks: "nope" })).listTasks()).kind, "malformed");
  const five = await make(jsonOf(500, "internal")).listTasks();
  assert.equal(five.kind, "server");
  assert.equal(five.message, "The task service hit an error (HTTP 500).");
});

test("client: approval flow through the real service, with the sensitive tool gated", async () => {
  const counter = { n: 0 };
  const sens = { id: "s1", intent: "Do the sensitive thing", kind: "tool", tool: "test_sensitive", args: { key: "k", value: "v" }, dependsOn: [], verification: { method: "state_check" } };
  const { client, until } = await boot({ script: plan([sens, verifyStep]), tools: [sensitive(counter)] });

  const created = await client.createTask({ objective: "Sensitive work", start: true });
  const waiting = await until(created.data.id, ["waiting_approval", "failed", "completed"]);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(counter.n, 0);

  const pending = mc.pendingApprovals(waiting);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "test_sensitive");
  assert.equal(pending[0].intent, "Do the sensitive thing");
  assert.deepEqual(JSON.parse(pending[0].argsText), { key: "k", value: "v" }, "the operator sees the exact arguments the approval is bound to");
  const summary = mc.summaryFromRecord(waiting);
  assert.equal(summary.pendingApprovals, 1);
  assert.equal(mc.groupTasks([summary]).attention.length, 1);

  const decided = await client.decideApproval(waiting.id, pending[0].requestId, true);
  assert.equal(decided.ok, true);
  const again = await client.decideApproval(waiting.id, pending[0].requestId, true);
  assert.equal(again.ok, false);
  assert.equal(again.kind, "challenge-unavailable", "the one-time code cannot be reused");
  assert.match(again.message, /run it again/);

  const done = await until(waiting.id, ["completed", "failed"]);
  assert.equal(done.status, "completed");
  assert.equal(counter.n, 1);
  assert.equal(mc.pendingApprovals(done).length, 0);
});

test("client: refusing an approval leaves the sensitive tool unexecuted", async () => {
  const counter = { n: 0 };
  const sens = { id: "s1", intent: "Do the sensitive thing", kind: "tool", tool: "test_sensitive", args: { key: "k", value: "v" }, dependsOn: [], verification: { method: "state_check" } };
  const { client, until } = await boot({ script: plan([sens, verifyStep]), tools: [sensitive(counter)] });
  const created = await client.createTask({ objective: "Sensitive work", start: true });
  const waiting = await until(created.data.id, ["waiting_approval"]);
  const r = await client.decideApproval(waiting.id, mc.pendingApprovals(waiting)[0].requestId, false);
  assert.equal(r.ok, true);
  const done = await until(waiting.id, ["completed", "failed"]);
  assert.equal(counter.n, 0);
  assert.equal(done.status, "failed");
  const failure = mc.describeFailure(mc.summaryFromRecord(done));
  assert.match(failure, /^(A step failed|Verification did not pass|Internal error|The task failed)/);
});

/* ---------------------------------- view-model ---------------------------------- */

const sum = (over = {}) => ({
  id: "t", title: "T", objective: "O", status: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  stepsTotal: 0, stepsCompleted: 0, stepsFailed: 0, stepsSkipped: 0, currentStep: null, pendingApprovals: 0, hasRecovery: false,
  error: null, resultSummary: null, verificationPassed: null, ...over,
});

test("allowed actions mirror the backend state machine for every status", async () => {
  const { isValidTaskTransition } = await import("../local/task-states.mjs");
  const statuses = ["queued", "planning", "running", "waiting_approval", "paused", "completed", "failed", "cancelled"];
  for (const s of statuses) {
    const a = mc.allowedActions(s);
    const terminal = mc.isTerminal(s);
    assert.equal(a.cancel, !terminal, `${s} cancel`);
    assert.equal(a.pause, !terminal && s !== "queued" && s !== "paused", `${s} pause`);
    assert.equal(a.start, s === "queued", `${s} start`);
    assert.equal(a.resume, s === "paused", `${s} resume`);
    if (a.pause) assert.equal(isValidTaskTransition(s, "paused"), true, `${s} -> paused is legal in the backend`);
    if (a.cancel) assert.equal(isValidTaskTransition(s, "cancelled"), true, `${s} -> cancelled is legal in the backend`);
    if (terminal) assert.deepEqual(a, { start: false, resume: false, pause: false, cancel: false });
  }
  assert.deepEqual(mc.allowedActions("something-new"), { start: false, resume: false, pause: false, cancel: false });
});

test("progress, failure wording and grouping", () => {
  assert.equal(mc.progressOf(sum({ status: "planning" })).label, "Planning steps…");
  assert.equal(mc.progressOf(sum({ status: "queued" })).label, "Not started");
  assert.deepEqual(mc.progressOf(sum({ status: "running", stepsTotal: 4, stepsCompleted: 1, stepsSkipped: 1 })), { done: 2, total: 4, percent: 50, label: "2 of 4 steps" });
  assert.equal(mc.progressOf(sum({ status: "running", stepsTotal: 3, stepsCompleted: 3 })).percent, 99, "never shows 100% before the task is verified complete");
  assert.equal(mc.progressOf(sum({ status: "completed", stepsTotal: 3, stepsCompleted: 3 })).percent, 100);

  assert.equal(mc.describeFailure(sum({ status: "completed" })), null);
  assert.equal(mc.describeFailure(sum({ status: "failed" })), "The task failed without recording a reason.");
  assert.equal(mc.describeFailure(sum({ status: "failed", error: { stage: "planning", reason: "No permitted free reasoning provider is configured." } })), "Planning failed: No permitted free reasoning provider is configured.");
  assert.equal(mc.describeFailure(sum({ status: "failed", error: { stage: "timeout", reason: "" } })), "The task timed out");
  assert.equal(mc.describeFailure(sum({ status: "failed", error: { stage: "weird", reason: "x" } })), "The task failed: x");

  const groups = mc.groupTasks([
    sum({ id: "a", status: "running", updatedAt: "2026-01-01T00:00:05Z" }),
    sum({ id: "b", status: "waiting_approval", pendingApprovals: 1 }),
    sum({ id: "c", status: "paused", hasRecovery: true }),
    sum({ id: "d", status: "paused", hasRecovery: false }),
    sum({ id: "e", status: "completed" }),
    sum({ id: "f", status: "failed", updatedAt: "2026-01-02T00:00:00Z" }),
    sum({ id: "g", status: "queued" }),
  ]);
  assert.deepEqual(groups.attention.map((t) => t.id).sort(), ["b", "c"]);
  assert.deepEqual(groups.active.map((t) => t.id).sort(), ["a", "d", "g"]);
  assert.deepEqual(groups.history.map((t) => t.id), ["f", "e"], "history is newest first");
  const counts = mc.countByStatus([sum({ status: "planning" }), sum({ status: "running" }), sum({ status: "failed" }), sum({ status: "queued" })]);
  assert.deepEqual(counts, { total: 4, running: 2, waiting: 0, paused: 0, completed: 0, failed: 1, cancelled: 0, queued: 1 });
});

test("polling slows down when hidden or disconnected and speeds up for a watched live task", () => {
  assert.equal(mc.nextPollDelay({ hidden: false, connected: false, hasLiveTask: true, detailOpen: true }), mc.POLL.disconnectedMs);
  assert.equal(mc.nextPollDelay({ hidden: true, connected: true, hasLiveTask: true, detailOpen: true }), mc.POLL.hiddenMs);
  assert.equal(mc.nextPollDelay({ hidden: false, connected: true, hasLiveTask: true, detailOpen: true }), mc.POLL.detailMs);
  assert.equal(mc.nextPollDelay({ hidden: false, connected: true, hasLiveTask: false, detailOpen: true }), mc.POLL.listMs);
  assert.equal(mc.nextPollDelay({ hidden: false, connected: true, hasLiveTask: true, detailOpen: false }), mc.POLL.listMs);
});

test("agent activity comes only from real routing events", () => {
  const log = [
    { ts: 30, agent: "Research", action: "Received directive", detail: "find x" },
    { ts: 20, agent: "Research", action: "Response delivered", detail: "ignored" },
    { ts: 10, agent: "Coding", action: "handling request", detail: "fix bug" },
    { ts: 40, agent: "Research", action: "handling request", detail: "who is y" },
    { ts: 50, agent: "Ghost", action: "Received directive" },
  ];
  const a = mc.agentActivity(log, ["Research", "Coding", "Finance"]);
  assert.deepEqual(a.Research, { handled: 2, lastAt: 40, lastDetail: "who is y" });
  assert.deepEqual(a.Coding, { handled: 1, lastAt: 10, lastDetail: "fix bug" });
  assert.deepEqual(a.Finance, { handled: 0, lastAt: null, lastDetail: null });
  assert.equal("Ghost" in a, false);
  assert.deepEqual(mc.toolsUsed({ steps: [{ tool: "a" }, { tool: null }, { tool: "b" }, { tool: "a" }] }), ["a", "b"]);
  assert.equal(mc.formatDuration(65000), "1m 5s");
  assert.equal(mc.formatDuration(-1), "—");
  assert.equal(mc.formatClock(null), "—");
});

/* ----------------------------------- goals ----------------------------------- */

test("goals: create, milestones, linking and progress", () => {
  const T = 1_700_000_000_000;
  let goals = [];
  assert.equal(goalsLib.addGoal(goals, { title: "   " }).ok, false);
  assert.equal(goalsLib.addGoal(goals, { title: "Ship", targetDate: "2026-02-30" }).ok, false, "impossible dates are rejected");
  goals = goalsLib.addGoal(goals, { title: "  Ship v1  ", description: "line1\nline2", targetDate: "2026-12-31" }, T, "g1").value;
  assert.equal(goals[0].title, "Ship v1");
  assert.equal(goals[0].description, "line1 line2");

  goals = goalsLib.addMilestone(goals, "g1", "Design", T, "m1").value;
  goals = goalsLib.addMilestone(goals, "g1", "Build", T, "m2").value;
  goals = goalsLib.addMilestone(goals, "g1", "Launch", T, "m3").value;
  assert.equal(goalsLib.addMilestone(goals, "g1", " ").ok, false);
  assert.equal(goalsLib.addMilestone(goals, "nope", "x").ok, false);

  goals = goalsLib.setMilestoneDone(goals, "g1", "m1", true, T + 1).value;
  goals = goalsLib.linkMilestoneTask(goals, "g1", "m2", "task-b").value;
  goals = goalsLib.linkMilestoneTask(goals, "g1", "m3", "task-c").value;
  const g = goals[0];
  assert.equal(g.milestones[0].doneAt, T + 1);

  const states = (st) => g.milestones.map((m) => goalsLib.milestoneState(m, st));
  assert.deepEqual(states({ "task-b": "running", "task-c": "failed" }), ["done", "in-progress", "blocked"]);
  assert.deepEqual(states({ "task-b": "completed" }), ["done", "done-by-task", "task-unknown"]);
  assert.deepEqual(states(null), ["done", "task-unknown", "task-unknown"], "offline: never guesses a linked task's status");

  const now = Date.UTC(2026, 5, 15, 12);
  const p1 = goalsLib.goalProgress(g, { "task-b": "completed", "task-c": "running" }, now);
  assert.equal(p1.done, 2);
  assert.equal(p1.percent, 67);
  assert.equal(p1.achieved, false);
  assert.equal(p1.overdue, false);
  assert.equal(p1.daysLeft, 199);
  const p2 = goalsLib.goalProgress(g, { "task-b": "completed", "task-c": "completed" }, now);
  assert.equal(p2.achieved, true);
  assert.equal(p2.percent, 100);
  const late = goalsLib.goalProgress({ ...g, targetDate: "2026-06-01" }, {}, now);
  assert.equal(late.overdue, true);
  assert.equal(late.daysLeft, -14);
  const lateButDone = goalsLib.goalProgress({ ...g, targetDate: "2026-06-01" }, { "task-b": "completed", "task-c": "completed" }, now);
  assert.equal(lateButDone.overdue, false);
  assert.equal(goalsLib.goalProgress({ ...g, milestones: [] }, {}, now).achieved, false, "a goal with no milestones is never 'achieved'");

  goals = goalsLib.setMilestoneDone(goals, "g1", "m1", false).value;
  assert.equal(goals[0].milestones[0].doneAt, null);
  goals = goalsLib.removeMilestone(goals, "g1", "m2").value;
  assert.equal(goals[0].milestones.length, 2);
  goals = goalsLib.updateGoal(goals, "g1", { status: "archived", title: "Renamed" }).value;
  assert.equal(goals[0].status, "archived");
  assert.equal(goalsLib.updateGoal(goals, "g1", { title: "" }).ok, false);
  assert.deepEqual(goalsLib.deleteGoal(goals, "g1"), []);
});

test("goals: limits and storage resilience", () => {
  let goals = [];
  for (let i = 0; i < goalsLib.GOAL_LIMITS.goals; i++) goals = goalsLib.addGoal(goals, { title: `g${i}` }).value;
  assert.equal(goalsLib.addGoal(goals, { title: "one too many" }).ok, false);
  let one = goalsLib.addGoal([], { title: "x" }, 1, "g").value;
  for (let i = 0; i < goalsLib.GOAL_LIMITS.milestones; i++) one = goalsLib.addMilestone(one, "g", `m${i}`).value;
  assert.equal(goalsLib.addMilestone(one, "g", "extra").ok, false);

  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  let notified = 0;
  const store = goalsLib.createGoalsStore(storage, () => notified++);
  assert.deepEqual(store.load(), []);
  assert.equal(store.save(one), true);
  assert.equal(notified, 1);
  assert.equal(store.load().length, 1);

  mem.set(goalsLib.GOALS_KEY, "{ broken");
  assert.deepEqual(store.load(), []);
  mem.set(goalsLib.GOALS_KEY, JSON.stringify([null, 5, { id: "", title: "x" }, { id: "ok", title: "Keep", targetDate: "garbage", status: "weird", milestones: [{ id: "m", title: "t", done: true, doneAt: "x", taskId: 5 }, "junk"] }]));
  const cleaned = store.load();
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].targetDate, null);
  assert.equal(cleaned[0].status, "active");
  assert.deepEqual(cleaned[0].milestones, [{ id: "m", title: "t", done: true, doneAt: null, taskId: null }]);

  const blocked = goalsLib.createGoalsStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } });
  assert.deepEqual(blocked.load(), []);
  assert.equal(blocked.save(one), false);
  assert.equal(goalsLib.createGoalsStore(null).save(one), false);
});

/* ------------------------------ native app helpers ------------------------------ */

const app = (o) => ({ id: "i", name: "App", executablePath: "C:\\a\\a.exe", args: [], category: "", favorite: false, source: "manual", addedAt: 0, lastLaunchedAt: null, launchCount: 0, availability: "available", availabilityMessage: null, running: false, pid: null, icon: null, ...o });

test("native app helpers: filtering, ordering, args text and status wording", () => {
  const list = [
    app({ id: "1", name: "Editor", category: "Dev", favorite: true }),
    app({ id: "2", name: "Browser", category: "Web", running: true }),
    app({ id: "3", name: "Old tool", category: "Dev", availability: "missing", availabilityMessage: "gone" }),
  ];
  const q = (o) => apps.filterApps(list, { search: "", category: "", filter: "all", ...o }).map((a) => a.id);
  assert.deepEqual(q({}), ["1", "2", "3"]);
  assert.deepEqual(q({ search: "  EDIT " }), ["1"]);
  assert.deepEqual(q({ search: "dev" }), ["1", "3"], "search also matches category");
  assert.deepEqual(q({ category: "Dev" }), ["1", "3"]);
  assert.deepEqual(q({ filter: "favorites" }), ["1"]);
  assert.deepEqual(q({ filter: "running" }), ["2"]);
  assert.deepEqual(q({ filter: "unavailable" }), ["3"]);
  assert.deepEqual(q({ category: "Dev", filter: "unavailable" }), ["3"]);
  assert.deepEqual(apps.categoriesOf(list), ["Dev", "Web"]);

  assert.deepEqual(apps.moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(apps.moveId(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(apps.moveId(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(apps.moveId(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(apps.moveId(["a", "b"], "zzz", 1), ["a", "b"]);

  assert.equal(apps.argsToText(["--open", "C:\\My Docs\\a.txt", "plain"]), '--open "C:\\My Docs\\a.txt" plain');
  assert.equal(apps.argsToText([]), "");

  assert.equal(apps.describeStatus(list[0]).label, "Not running");
  assert.equal(apps.describeStatus(list[1]).label, "Running");
  assert.equal(apps.describeStatus(list[2]).label, "Missing");
  assert.equal(apps.describeStatus(list[2]).tone, "bad");
  assert.match(apps.describeStatus(list[0]).detail, /only tell whether a program it started/);
});

test("native app client reports the browser case honestly and survives a broken bridge", async () => {
  assert.equal(apps.nativeAppsAvailable(), false);
  const r = await apps.nativeApps.list();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "no-desktop");
  assert.match(r.error.message, /desktop app/);

  globalThis.window = { exileDesktop: { nativeApps: { list: async () => { throw new Error("ipc dead"); }, launch: async () => ({ weird: true }), refresh: async () => ({ ok: true, apps: [], support: {}, platform: "win32" }) } } };
  try {
    assert.equal(apps.nativeAppsAvailable(), true);
    assert.equal((await apps.nativeApps.list()).error.code, "bridge-error");
    assert.equal((await apps.nativeApps.launch("x")).error.code, "bridge-error", "malformed reply is not trusted");
    assert.equal((await apps.nativeApps.refresh()).ok, true);
  } finally {
    delete globalThis.window;
  }
});
