import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCachedLoader, isProtected, terminateSelectedProcess } from "../local/arc-process-manager.mjs";
import { createArcAudit } from "../local/arc-audit.mjs";

test("cached loader: concurrent callers share one load (single-flight)", async () => {
  let calls = 0;
  const loader = createCachedLoader(async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return [calls]; }, { ttlMs: 1000 });
  const results = await Promise.all([loader.get(), loader.get(), loader.get()]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [[1], [1], [1]]);
});

test("cached loader: TTL reuse, expiry and invalidation", async () => {
  let t = 0, calls = 0;
  const loader = createCachedLoader(async () => ++calls, { ttlMs: 100, now: () => t });
  assert.equal(await loader.get(), 1);
  t = 50; assert.equal(await loader.get(), 1);
  t = 150; assert.equal(await loader.get(), 2);
  loader.invalidate(); assert.equal(await loader.get(), 3);
});

test("cached loader: failures are not cached and do not wedge later calls", async () => {
  let calls = 0;
  const loader = createCachedLoader(async () => { if (++calls === 1) throw new Error("boom"); return "ok"; }, { ttlMs: 1000 });
  await assert.rejects(loader.get(), /boom/);
  assert.equal(await loader.get(), "ok");
});

test("protection: system, security, self and launcher processes are protected; ordinary apps are not", () => {
  const self = new Set([4242, 4243]);
  assert.equal(isProtected({ pid: 4, name: "System" }, self), true);
  assert.equal(isProtected({ pid: 900, name: "lsass" }, self), true);
  assert.equal(isProtected({ pid: 900, name: "MsMpEng" }, self), true);
  assert.equal(isProtected({ pid: 900, name: "x", path: "C:\\Windows\\System32\\x.exe" }, self), true);
  assert.equal(isProtected({ pid: 4242, name: "node" }, self), true, "this server");
  assert.equal(isProtected({ pid: 4243, name: "whatever" }, self), true, "the launcher");
  assert.equal(isProtected({ pid: 5000, name: "notepad", path: "C:\\Apps\\notepad.exe" }, self), false);
});

test("terminate: refuses without confirmation and force acknowledgement (platform independent)", async () => {
  const r = await terminateSelectedProcess({ pid: 5000, expectedName: "notepad", expectedStartTime: new Date().toISOString() });
  assert.equal(r.ok, false);
  const low = await terminateSelectedProcess({ pid: 4, confirmed: true, forceConfirmed: true });
  assert.equal(low.ok, false);
});

test("audit: records outcome without paths or command lines, private file, bounded read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-audit-"));
  try {
    const audit = createArcAudit(dir, { now: () => new Date("2026-01-01T00:00:00Z") });
    audit.record({ action: "terminate-process", pid: 5000, name: "notepad", ok: false, error: "Process identity changed; refresh the app list.", confirmed: true, path: "C:\\secret\\x.exe", commandLine: "--token=abc" });
    audit.record({ action: "terminate-process", pid: 5001, name: "calc", ok: true, method: "graceful-close", confirmed: true, forceConfirmed: true });
    const rows = audit.read();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[1].method, "graceful-close");
    const raw = fs.readFileSync(audit.file, "utf8");
    assert.ok(!/secret|token=abc/.test(raw));
    if (process.platform !== "win32") assert.equal(fs.statSync(audit.file).mode & 0o077, 0);
    assert.deepEqual(createArcAudit(path.join(dir, "missing")).read(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
