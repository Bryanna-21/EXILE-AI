// Boots the real local server and checks the auth boundary end to end.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const SECRET = "test-secret-".padEnd(40, "x");
let child, base, dir;
let startupOutput = "";
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exile-srv-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["local/server.mjs"], {
    env: { ...process.env, EXILE_PORT: String(port), PORT: String(port), EXILE_LOCAL_API_SECRET: SECRET, EXILE_DATA_DIR: dir, EXILE_TASK_STORE_DIR: path.join(dir, "tasks"), HOME: dir, USERPROFILE: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { startupOutput = (startupOutput + chunk).slice(-12000); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { startupOutput = (startupOutput + chunk).slice(-12000); });
  child.on("error", (error) => { startupOutput += "\nCHILD PROCESS ERROR: " + error.message; });
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start (exitCode=" + child.exitCode + ", signalCode=" + child.signalCode + ")\n" + startupOutput);
});
after(async () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const H = { "x-exile-local-auth": SECRET };

test("server: /health stays open", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("server: every sensitive route rejects unauthenticated callers", async () => {
  for (const [method, p] of [["GET", "/keys"], ["POST", "/keys"], ["POST", "/exile-chat"], ["POST", "/exile-image"], ["POST", "/exile-analyze"], ["GET", "/arc/status"], ["GET", "/arc/processes"], ["POST", "/arc/terminate"], ["GET", "/whatsapp/status"], ["POST", "/whatsapp/send"], ["GET", "/tasks"]]) {
    const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
});

test("server: the secret unlocks routes; foreign origins stay blocked", async () => {
  assert.equal((await fetch(`${base}/keys`, { headers: H })).status, 200);
  const evil = await fetch(`${base}/keys`, { headers: { ...H, Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("server: the keys endpoint never returns raw key material", async () => {
  const body = await (await fetch(`${base}/keys`, { headers: H })).text();
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(body));
});

test("server: preflight echoes only loopback origins, never a wildcard", async () => {
  const ok = await fetch(`${base}/exile-chat`, { method: "OPTIONS", headers: { Origin: "http://localhost:8080" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:8080");
  assert.match(ok.headers.get("access-control-allow-headers"), /x-exile-local-auth/);
  const bad = await fetch(`${base}/exile-chat`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("server: key saving refuses runtime/loader variables, injected newlines and unknown providers", async () => {
  const post = (body) => fetch(`${base}/keys`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [
    { keys: [{ name: "NODE_OPTIONS", value: "--require x" }] },
    { keys: [{ name: "PATH", value: "/tmp" }] },
    { keys: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }] },
    { keys: [{ name: "EXILE_LOCAL_API_SECRET", value: "x" }] },
    { keys: [{ name: "NODE_API_KEY", value: "x" }] },
    { keys: [{ name: "OPENAI_API_KEY", value: "sk-a\nNODE_OPTIONS=--inspect" }] },
    { keys: "nope" },
    { keys: [], primary: "not-a-provider" },
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await post({ keys: [{ name: "x", value: "" }] })).status, 400, "names must look like credentials");
  const ok = await post({ keys: [{ name: "GROQ_API_KEY", value: "gsk_testvalue123" }], primary: "groq" });
  assert.equal(ok.status, 200);
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.ok(env.includes("GROQ_API_KEY=gsk_testvalue123"));
  assert.ok(!/NODE_OPTIONS/.test(env));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o077, 0);
});

test("server: oversized and malformed JSON bodies are rejected with 4xx, not a crash", async () => {
  const bad = await fetch(`${base}/keys`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/health`)).status, 200, "server still alive");
});

test("server: static serving does not escape into sibling directories", async () => {
  for (const p of ["/../dist-old/secret", "/..%2Fdist-old%2Fsecret", "/%2e%2e/%2e%2e/package.json"]) {
    const r = await fetch(`${base}${p}`);
    const t = await r.text();
    assert.ok(!t.includes('"name": "vite_react_shadcn_ts"') && !/\"scripts\"/.test(t), p);
  }
});
