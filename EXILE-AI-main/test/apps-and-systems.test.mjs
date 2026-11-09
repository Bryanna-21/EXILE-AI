import test from "node:test";
import assert from "node:assert/strict";

const tabs = await import("../src/lib/appTabs.ts");
const { linkProblem } = await import("../src/lib/appRegistry.ts");
const { evaluateSystems, overallState } = await import("../src/lib/systemsCheck.ts");

/* ------------------------------- application tabs ------------------------------- */

test("tabs: sanitize drops unknown ids, duplicates, non-strings and enforces the cap", () => {
  assert.deepEqual(tabs.sanitizeTabs(["a", "ghost", "b", "a", 7, null], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(tabs.sanitizeTabs("nope", ["a"]), []);
  const many = Array.from({ length: 50 }, (_, i) => `id${i}`);
  assert.equal(tabs.sanitizeTabs(many, many).length, tabs.MAX_TABS);
});

test("tabs: open is idempotent, close removes, move reorders within bounds", () => {
  assert.deepEqual(tabs.openTab(["a"], "a"), ["a"]);
  assert.deepEqual(tabs.openTab(["a"], "b"), ["a", "b"]);
  assert.deepEqual(tabs.closeTab(["a", "b"], "a"), ["b"]);
  assert.deepEqual(tabs.moveTab(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
  assert.deepEqual(tabs.moveTab(["a", "b"], "a", -1), ["a", "b"], "moving past the start is a no-op");
  assert.equal(tabs.openTab(Array.from({ length: tabs.MAX_TABS }, (_, i) => `t${i}`), "new").length, tabs.MAX_TABS);
});

test("tabs: persistence round-trips and survives broken or missing storage", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  tabs.saveTabs(["a", "b"], storage);
  assert.deepEqual(tabs.loadTabs(storage), ["a", "b"]);
  mem.set(tabs.TABS_KEY, "{not json");
  assert.deepEqual(tabs.loadTabs(storage), []);
  mem.set(tabs.TABS_KEY, JSON.stringify({ a: 1 }));
  assert.deepEqual(tabs.loadTabs(storage), []);
  assert.doesNotThrow(() => tabs.saveTabs(["a"], { setItem: () => { throw new Error("quota"); } }));
  assert.deepEqual(tabs.loadTabs({ getItem: () => { throw new Error("blocked"); } }), []);
});

/* --------------------------------- web link safety --------------------------------- */

test("web links: script, data and file schemes are refused; normal links and deep links pass", () => {
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "  data:text/html,x", "vbscript:x", "file:///etc/passwd", "blob:https://x/y"]) {
    assert.ok(linkProblem(bad), bad);
  }
  for (const ok of ["https://example.com", "mailto:a@b.c", "spotify:track:1", "tel:+254700000000", "example.com"]) {
    assert.equal(linkProblem(ok), null, ok);
  }
});

/* ---------------------------------- systems checks ---------------------------------- */

const caps = (configured, tools) => ({ ok: true, checkedAt: "x", planner: { configured, providers: configured ? ["p"] : [], permitted: ["p"] }, limits: { maxSteps: 12, taskTimeoutMs: 600000 }, tools });

test("systems: everything unreachable reports down, never a fake pass", () => {
  const rows = evaluateSystems({ browserOnline: true, health: null, tasks: null, desktopBridge: false, nativeAppCount: null });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.api.state, "down");
  assert.equal(by.ai.state, "n/a");
  assert.equal(by.tasks.state, "n/a");
  assert.equal(by.desktop.state, "n/a");
  assert.equal(overallState(rows).state, "down");
});

test("systems: states follow the probed facts", () => {
  const rows = evaluateSystems({
    browserOnline: true,
    health: { providers: ["openrouter"], keysDetected: 1 },
    tasks: caps(true, [{ name: "a", available: true }, { name: "b", available: false }]),
    desktopBridge: true,
    nativeAppCount: 1,
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.ai.state, "ok");
  assert.match(by.ai.detail, /openrouter/);
  assert.equal(by.tasks.state, "ok");
  assert.match(by.tasks.detail, /1 of 2 tools available/);
  assert.match(by.desktop.detail, /1 program imported/);
  assert.equal(overallState(rows).state, "ok");

  const noKey = evaluateSystems({ browserOnline: false, health: { providers: [], keysDetected: 0 }, tasks: caps(false, []), desktopBridge: false, nativeAppCount: null });
  const nb = Object.fromEntries(noKey.map((r) => [r.id, r]));
  assert.equal(nb.network.state, "down");
  assert.equal(nb.ai.state, "warn");
  assert.equal(nb.tasks.state, "warn");
  assert.equal(overallState(noKey).state, "down");
  assert.equal(overallState(noKey.filter((r) => r.id !== "network")).state, "warn");
});
