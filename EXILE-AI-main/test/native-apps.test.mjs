import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const v = require("../electron/native-apps/validation.cjs");
const { NativeAppStore } = require("../electron/native-apps/store.cjs");
const { createNativeAppService } = require("../electron/native-apps/service.cjs");
const { discoverFromShortcuts, collectShortcuts } = require("../electron/native-apps/discovery.cjs");
const { registerNativeAppIpc, CHANNELS, isTrustedSender } = require("../electron/native-apps/index.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "exile-native-apps-"));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

/* ============================ validation (win32 rules) ============================ */

test("windows executable paths: accepts plain local .exe paths", () => {
  for (const p of ["C:\\Program Files\\App\\app.exe", "D:/Tools/My App/tool.EXE", "c:\\a\\b\\c.exe"]) {
    assert.equal(v.validateExecutablePathSyntax(p, "win32").ok, true, p);
  }
});

test("windows executable paths: rejects unsafe or non-program paths", () => {
  const bad = [
    "", "app.exe", ".\\app.exe", "\\\\server\\share\\app.exe", "//server/share/app.exe",
    "\\\\?\\C:\\app.exe", "\\\\.\\pipe\\x", "C:app.exe",
    "C:\\a\\run.bat", "C:\\a\\run.cmd", "C:\\a\\run.ps1", "C:\\a\\run.vbs", "C:\\a\\setup.msi",
    "C:\\a\\link.lnk", "C:\\a\\noext", "C:\\a\\app.exe:stream", "C:\\a\\..\\b\\app.exe",
    "C:\\a\\.\\app.exe", "C:\\a\\app.exe.", "C:\\a \\app.exe", "C:\\a\\app*.exe", "C:\\a\\a?.exe",
    "C:\\a\\a|b.exe", "C:\\a\\a<b.exe", "C:\\a\\con.exe", "C:\\a\\NUL.exe", "C:\\a\\COM1.exe",
    "C:\\a\\app\u0000.exe", "C:\\a\\app\n.exe", "C:\\" + "x".repeat(5000) + ".exe",
  ];
  for (const p of bad) {
    assert.equal(v.validateExecutablePathSyntax(p, "win32").ok, false, JSON.stringify(p).slice(0, 60));
  }
  assert.equal(v.validateExecutablePathSyntax(42, "win32").ok, false);
  assert.equal(v.validateExecutablePathSyntax(null, "win32").ok, false);
});

test("unsupported platforms are reported, not guessed", () => {
  assert.equal(v.platformSupport("darwin").supported, false);
  assert.equal(v.validateExecutablePathSyntax("/Applications/x", "darwin").error.code, "unsupported-platform");
  assert.equal(v.platformSupport("win32").discovery, true);
});

test("arguments are split without shell semantics", () => {
  const r = v.parseArgumentString('--flag "two words" plain C:\\Users\\me\\file.txt');
  assert.deepEqual(r.args, ["--flag", "two words", "plain", "C:\\Users\\me\\file.txt"]);
  const hostile = v.parseArgumentString('%PATH% $HOME `id` && calc ; rm -rf / | more > out $(whoami)');
  assert.equal(hostile.ok, true);
  assert.deepEqual(hostile.args, ["%PATH%", "$HOME", "`id`", "&&", "calc", ";", "rm", "-rf", "/", "|", "more", ">", "out", "$(whoami)"]);
  assert.deepEqual(v.parseArgumentString("").args, []);
  assert.deepEqual(v.parseArgumentString('   ').args, []);
  assert.deepEqual(v.parseArgumentString('""').args, [""]);
});

test("arguments: rejects control characters, unclosed quotes and oversize input", () => {
  assert.equal(v.parseArgumentString("a\nb").ok, false);
  assert.equal(v.parseArgumentString("a\rb").ok, false);
  assert.equal(v.parseArgumentString("a\u0000b").ok, false);
  assert.equal(v.parseArgumentString('a "b').ok, false);
  assert.equal(v.parseArgumentString("x".repeat(9000)).ok, false);
  assert.equal(v.parseArgumentString(Array.from({ length: 40 }, (_, i) => `a${i}`).join(" ")).ok, false);
  assert.equal(v.parseArgumentString(5).ok, false);
  assert.equal(v.validateArgumentArray("--x").ok, false);
  assert.equal(v.validateArgumentArray([1]).ok, false);
});

test("command interpreters can be added only without arguments", () => {
  assert.equal(v.validateProgramAndArgs("C:\\Windows\\System32\\cmd.exe", ["/c", "calc"], "win32").ok, false);
  assert.equal(v.validateProgramAndArgs("C:\\Windows\\System32\\CMD.EXE", ["/c", "calc"], "win32").ok, false);
  assert.equal(v.validateProgramAndArgs("C:\\Windows\\System32\\powershell.exe", ["-c", "x"], "win32").ok, false);
  assert.equal(v.validateProgramAndArgs("C:\\Windows\\System32\\cmd.exe", [], "win32").ok, true);
  assert.equal(v.validateProgramAndArgs("C:\\Apps\\editor.exe", ["file.txt"], "win32").ok, true);
});

test("duplicate keys are case-insensitive on Windows and case-sensitive on Linux", () => {
  assert.equal(v.dedupeKey("C:\\Apps\\A.exe", [], "win32"), v.dedupeKey("c:/apps/a.exe", [], "win32").replace("c:\\apps/a.exe", "c:\\apps\\a.exe"));
  assert.equal(v.dedupeKey("C:\\Apps\\A.exe", [], "win32"), v.dedupeKey("c:\\apps\\a.exe", [], "win32"));
  assert.notEqual(v.dedupeKey("C:\\Apps\\A.exe", ["x"], "win32"), v.dedupeKey("C:\\Apps\\A.exe", [], "win32"));
  assert.notEqual(v.dedupeKey("/opt/A", [], "linux"), v.dedupeKey("/opt/a", [], "linux"));
});

test("names and categories are cleaned and bounded", () => {
  assert.equal(v.validateName("  My\nApp\t ").value, "My App");
  assert.equal(v.validateName("   ").ok, false);
  assert.equal(v.validateName(5).ok, false);
  assert.equal(v.validateName("x".repeat(81)).ok, false);
  assert.equal(v.validateCategory(undefined).value, "");
  assert.equal(v.validateCategory("x".repeat(41)).ok, false);
});

test("inspectExecutable reports missing, directory and non-executable states on real files", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "prog");
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(v.inspectExecutable(file, "linux", fs).ok, true);
    assert.equal(v.inspectExecutable(path.join(dir, "nope"), "linux", fs).status, "missing");
    assert.equal(v.inspectExecutable(dir, "linux", fs).status, "invalid");
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    if (process.getuid && process.getuid() !== 0) {
      assert.equal(v.inspectExecutable(plain, "linux", fs).status, "inaccessible");
    }
    assert.equal(v.inspectExecutable("relative/prog", "linux", fs).status, "invalid");
  } finally {
    cleanup(dir);
  }
});

/* ================================== store =================================== */

test("store persists across restarts and writes atomically with private permissions", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "native-apps.json");
    const a = new NativeAppStore(file, "win32");
    a.apps.push({ id: "11111111-aaaa", name: "Editor", executablePath: "C:\\Apps\\editor.exe", args: ["--x"], category: "Dev", favorite: true, source: "manual", addedAt: 1, lastLaunchedAt: null, launchCount: 0 });
    a.save();
    const b = new NativeAppStore(file, "win32");
    assert.equal(b.apps.length, 1);
    assert.equal(b.apps[0].name, "Editor");
    assert.deepEqual(b.apps[0].args, ["--x"]);
    assert.equal(b.apps[0].favorite, true);
    assert.equal(b.loadWarning, null);
    assert.equal(fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally {
    cleanup(dir);
  }
});

test("store backs up a corrupt file instead of silently discarding it", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "native-apps.json");
    fs.writeFileSync(file, "{ not json");
    const s = new NativeAppStore(file, "win32");
    assert.equal(s.apps.length, 0);
    assert.match(s.loadWarning, /corrupt/);
    const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{ not json");
  } finally {
    cleanup(dir);
  }
});

test("store drops invalid or duplicate entries on load, keeps valid ones, and backs up the original", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "native-apps.json");
    const good = { id: "22222222-bbbb", name: "Good", executablePath: "C:\\Apps\\good.exe", args: [], category: "", favorite: false, source: "manual", addedAt: 1 };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      apps: [
        good,
        { ...good, id: "33333333-cccc", name: "Dup" },
        { ...good, id: "44444444-dddd", name: "Script", executablePath: "C:\\Apps\\x.bat" },
        { ...good, id: "55555555-eeee", name: "Interp", executablePath: "C:\\Windows\\cmd.exe", args: ["/c", "calc"] },
        { id: "../../etc", name: "Bad id", executablePath: "C:\\Apps\\b.exe", args: [] },
        "garbage",
      ],
    }));
    const s = new NativeAppStore(file, "win32");
    assert.deepEqual(s.apps.map((a) => a.name), ["Good"]);
    assert.match(s.loadWarning, /5 saved applications were invalid/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 1);
  } finally {
    cleanup(dir);
  }
});

test("store refuses to overwrite a file written by a newer version", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "native-apps.json");
    fs.writeFileSync(file, JSON.stringify({ version: 99, apps: [] }));
    const s = new NativeAppStore(file, "win32");
    assert.throws(() => s.save(), /cannot be modified/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 99);
  } finally {
    cleanup(dir);
  }
});

/* ================================ discovery ================================= */

test("discovery walks Start Menu folders without following symlinks and bounds the scan", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, "Sub", "Deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "A.lnk"), "");
    fs.writeFileSync(path.join(dir, "Sub", "B.lnk"), "");
    fs.writeFileSync(path.join(dir, "Sub", "Deep", "C.LNK"), "");
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    fs.symlinkSync(dir, path.join(dir, "loop"));
    const found = collectShortcuts(dir).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["A.lnk", "B.lnk", "C.LNK"]);
    assert.equal(collectShortcuts(dir, fs, 2).length, 2);
  } finally {
    cleanup(dir);
  }
});

test("discovery reads shortcuts only, filters unsafe targets and reports why", () => {
  const dir = tmp();
  try {
    for (const n of ["Editor.lnk", "Editor Copy.lnk", "Uninstall Editor.lnk", "Script.lnk", "Broken.lnk", "Shell.lnk", "Args.lnk", "Folder.lnk", "BadArgs.lnk"]) {
      fs.writeFileSync(path.join(dir, n), "");
    }
    const targets = {
      "Editor.lnk": { target: "C:\\Apps\\editor.exe", args: "" },
      "Editor Copy.lnk": { target: "c:\\apps\\EDITOR.exe", args: "" },
      "Uninstall Editor.lnk": { target: "C:\\Apps\\unins000.exe", args: "" },
      "Script.lnk": { target: "C:\\Apps\\run.bat", args: "" },
      "Broken.lnk": null,
      "Shell.lnk": { target: "C:\\Windows\\System32\\cmd.exe", args: "/c calc" },
      "Args.lnk": { target: "C:\\Apps\\viewer.exe", args: '--open "C:\\My Docs\\a.txt"' },
      "Folder.lnk": { target: "", args: "" },
      "BadArgs.lnk": { target: "C:\\Apps\\other.exe", args: 'unclosed "quote' },
    };
    const inspected = [];
    const result = discoverFromShortcuts({
      roots: [dir],
      platform: "win32",
      readShortcut: (lnk) => {
        const t = targets[path.basename(lnk)];
        if (t === null) throw new Error("unreadable");
        return t;
      },
      inspect: (p) => {
        inspected.push(p);
        const r = v.validateExecutablePathSyntax(p, "win32");
        return r.ok ? { ok: true, path: r.path, realPath: r.path } : { ok: false, status: "invalid", error: r.error };
      },
    });
    assert.deepEqual(result.candidates.map((c) => c.name), ["Args", "Editor"]);
    assert.deepEqual(result.candidates.find((c) => c.name === "Args").args, ["--open", "C:\\My Docs\\a.txt"]);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.reason, s.count]));
    assert.equal(reasons["installer, uninstaller or help shortcut"], 1);
    assert.equal(reasons["target is not a plain .exe program"], 1);
    assert.equal(reasons["shortcut could not be read"], 1);
    assert.equal(reasons["command interpreter with arguments"], 1);
    assert.equal(reasons["shortcut has no program target"], 1);
    assert.equal(reasons["shortcut arguments are not supported"], 1);
    assert.equal(result.scanned, 9);
    assert.ok(!inspected.includes("C:\\Apps\\unins000.exe"), "filtered shortcuts are not even inspected");
  } finally {
    cleanup(dir);
  }
});

/* ===================== service against real files and processes ===================== */

/** A fake "application": a script that records its argv and a marker, then lingers briefly. */
function makeProbeApp(dir, name = "probe-app", lingerSeconds = "0.4") {
  const file = path.join(dir, name);
  const out = path.join(dir, `${name}.ran`);
  fs.writeFileSync(file, `#!/bin/sh\n: > "${out}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${out}"; done\nsleep ${lingerSeconds}\n`, { mode: 0o755 });
  return { file, out };
}

function makeService(dir, overrides = {}) {
  const store = new NativeAppStore(path.join(dir, "native-apps.json"), "linux");
  const spawned = [];
  const queue = { exe: [], shortcut: [] };
  const confirms = [];
  const deps = {
    store,
    platform: "linux",
    spawn: (...a) => { spawned.push(a); return spawn(...a); },
    inspect: (p) => v.inspectExecutable(p, "linux", fs),
    readShortcut: () => ({ target: "", args: "" }),
    startMenuRoots: () => [],
    chooseExecutable: async () => queue.exe.shift() ?? null,
    chooseShortcut: async () => queue.shortcut.shift() ?? null,
    confirm: async (...a) => { confirms.push(a); return overrides.confirmAnswer ?? true; },
    getIcon: async () => "data:image/png;base64,AAAA",
    ...overrides.deps,
  };
  return { service: createNativeAppService(deps), store, spawned, queue, confirms };
}

test("importing an application NEVER runs it, and the entry persists across a restart", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file);
    const r = await service.importManual({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.imported, ["probe-app"]);
    assert.equal(r.apps.length, 1);
    assert.equal(r.apps[0].availability, "available");
    assert.equal(r.apps[0].running, false);
    assert.equal(r.apps[0].icon, "data:image/png;base64,AAAA");
    await sleep(300);
    assert.equal(fs.existsSync(app.out), false, "import must not execute the program");

    const again = makeService(dir); // simulated restart: fresh store, same file
    const listed = await again.service.list();
    assert.equal(listed.apps.length, 1);
    assert.equal(listed.apps[0].name, "probe-app");
    assert.equal(fs.existsSync(app.out), false);
  } finally {
    cleanup(dir);
  }
});

test("duplicate imports are refused with a clear message", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file, app.file);
    assert.equal((await service.importManual({})).ok, true);
    const dup = await service.importManual({});
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, "duplicate");
    assert.equal((await service.list()).apps.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("cancelling the file dialog changes nothing", async () => {
  const dir = tmp();
  try {
    const { service } = makeService(dir);
    const r = await service.importManual({});
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, true);
    assert.equal(r.apps.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("launch starts a real process without a shell and tracks running then stopped", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir, "probe-app", "0.6");
    const { service, spawned, queue } = makeService(dir);
    queue.exe.push(app.file);
    const added = await service.importManual({});
    const id = added.addedId;

    const launched = await service.launch(id);
    assert.equal(launched.ok, true);
    assert.equal(launched.launched, true);
    assert.equal(launched.apps[0].running, true);
    assert.ok(Number.isInteger(launched.pid) && launched.pid > 0);
    assert.match(launched.message, /own window, outside EXILE/);

    assert.equal(spawned.length, 1);
    const [exe, argv, opts] = spawned[0];
    assert.equal(exe, fs.realpathSync(app.file), "spawn must use the inspected resolved path");
    assert.equal(opts.cwd, path.dirname(fs.realpathSync(app.file)), "working directory must follow the resolved executable");
    assert.deepEqual(argv, []);
    assert.equal(opts.shell, false, "never launched through a shell");
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio, "ignore");

    assert.equal(await waitFor(() => fs.existsSync(app.out)), true, "the program really ran");

    const second = await service.launch(id);
    assert.equal(second.alreadyRunning, true, "no duplicate instance while tracked as running");
    assert.equal(spawned.length, 1);

    assert.equal(await waitFor(() => !process.kill || (() => { try { process.kill(launched.pid, 0); return false; } catch { return true; } })(), 6000), true);
    await sleep(100);
    const after = await service.list();
    assert.equal(after.apps[0].running, false, "tracked state returns to stopped after exit");
    assert.equal(after.apps[0].launchCount, 1);
    assert.ok(after.apps[0].lastLaunchedAt > 0);

    const hist = service.history().history;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].outcome, "launched");
    assert.equal(hist[0].name, "probe-app");
  } finally {
    cleanup(dir);
  }
});

test("several different applications can run at once", async () => {
  const dir = tmp();
  try {
    const a = makeProbeApp(dir, "probe-a", "0.8");
    const b = makeProbeApp(dir, "probe-b", "0.8");
    const { service, queue } = makeService(dir);
    queue.exe.push(a.file, b.file);
    const ia = (await service.importManual({})).addedId;
    const ib = (await service.importManual({})).addedId;
    await service.launch(ia);
    const both = await service.launch(ib);
    assert.deepEqual(both.apps.map((x) => x.running), [true, true]);
    assert.equal(await waitFor(() => fs.existsSync(a.out) && fs.existsSync(b.out)), true);
  } finally {
    cleanup(dir);
  }
});

test("shell metacharacters in arguments reach the program as literal text and are never interpreted", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir, "probe-args", "0.1");
    const injected = path.join(dir, "INJECTED");
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file);
    const id = (await service.importManual({})).addedId;
    const argsText = `; touch ${injected} && echo pwn | cat "two words" $(touch ${injected}) \`touch ${injected}\` $HOME`;
    const upd = await service.update({}, id, { argsText });
    assert.equal(upd.ok, true);
    await service.launch(id);
    assert.equal(await waitFor(() => fs.existsSync(app.out) && fs.readFileSync(app.out, "utf8").includes("$HOME")), true);
    const lines = fs.readFileSync(app.out, "utf8").trimEnd().split("\n");
    assert.deepEqual(lines, [";", "touch", injected, "&&", "echo", "pwn", "|", "cat", "two words", `$(touch`, `${injected})`, "`touch", `${injected}\``, "$HOME"]);
    await sleep(300);
    assert.equal(fs.existsSync(injected), false, "nothing was executed by a shell");
  } finally {
    cleanup(dir);
  }
});

test("a hostile application NAME is stored as inert text and cannot influence launching", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir, "probe-name", "0.1");
    const injected = path.join(dir, "INJECTED2");
    const { service, queue, spawned } = makeService(dir);
    queue.exe.push(app.file);
    const id = (await service.importManual({})).addedId;
    const r = await service.update({}, id, { name: `x"; touch ${injected}; "` });
    assert.equal(r.ok, true);
    await service.launch(id);
    assert.equal(spawned[0][0], app.file);
    await sleep(400);
    assert.equal(fs.existsSync(injected), false);
  } finally {
    cleanup(dir);
  }
});

test("changing launch arguments needs native confirmation; declining leaves the entry unchanged", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const denied = makeService(dir, { confirmAnswer: false });
    denied.queue.exe.push(app.file);
    const id = (await denied.service.importManual({})).addedId;
    const r = await denied.service.update({}, id, { argsText: "--danger" });
    assert.equal(r.cancelled, true);
    assert.deepEqual(r.apps[0].args, []);
    assert.equal(denied.confirms.length, 1);
    assert.match(denied.confirms[0][1].detail, /--danger/);

    const allowed = makeService(dir, { confirmAnswer: true });
    const r2 = await allowed.service.update({}, id, { argsText: "--ok" });
    assert.deepEqual(r2.apps[0].args, ["--ok"]);
    const noPrompt = await allowed.service.update({}, id, { name: "Renamed", favorite: true, category: "Tools" });
    assert.equal(allowed.confirms.length, 1, "name/category/favourite edits do not prompt");
    assert.equal(noPrompt.apps[0].name, "Renamed");
    assert.equal(noPrompt.apps[0].favorite, true);
    assert.equal(noPrompt.apps[0].category, "Tools");
  } finally {
    cleanup(dir);
  }
});

test("update rejects fields that must not be edited from the page, including paths", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file);
    const id = (await service.importManual({})).addedId;
    for (const patch of [{ executablePath: "/bin/sh" }, { id: "x" }, { args: ["-c", "x"] }, { source: "manual" }, { favorite: "yes" }, null, []]) {
      const r = await service.update({}, id, patch);
      assert.equal(r.ok, false, JSON.stringify(patch));
    }
    assert.equal((await service.list()).apps[0].executablePath, app.file);
  } finally {
    cleanup(dir);
  }
});

test("interpreters can be imported but never saved with arguments", async () => {
  const dir = tmp();
  try {
    const shell = makeProbeApp(dir, "bash");
    const { service, queue } = makeService(dir);
    queue.exe.push(shell.file);
    const added = await service.importManual({});
    assert.equal(added.ok, true);
    const r = await service.update({}, added.addedId, { argsText: "-c 'id'" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid-args");
  } finally {
    cleanup(dir);
  }
});

test("missing executables are detected, cannot launch, and are recorded in history", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file);
    const id = (await service.importManual({})).addedId;
    fs.rmSync(app.file);
    const listed = await service.list();
    assert.equal(listed.apps[0].availability, "missing");
    assert.match(listed.apps[0].availabilityMessage, /no longer exists/);
    const r = await service.launch(id);
    assert.equal(r.ok, false);
    assert.equal(r.status, "missing");
    const h = service.history().history;
    assert.equal(h[0].outcome, "failed");
  } finally {
    cleanup(dir);
  }
});

test("a file that cannot be started reports a launch failure instead of crashing", async () => {
  const dir = tmp();
  try {
    // Passes the pre-launch checks (a real, executable file) but the OS cannot start it:
    // the shebang names an interpreter that does not exist, so execve fails.
    const bad = path.join(dir, "not-a-program");
    fs.writeFileSync(bad, "#!/nonexistent/exile-interpreter\n", { mode: 0o755 });
    const { service, queue } = makeService(dir);
    queue.exe.push(bad);
    const id = (await service.importManual({})).addedId;
    const r = await service.launch(id);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "launch-failed");
    assert.ok(r.error.message.length > 0);
    assert.equal((await service.list()).apps[0].running, false);
  } finally {
    cleanup(dir);
  }
});

test("relinking repairs a missing application and refuses duplicates", async () => {
  const dir = tmp();
  try {
    const original = makeProbeApp(dir, "probe-old");
    const moved = makeProbeApp(dir, "probe-new");
    const { service, queue } = makeService(dir);
    queue.exe.push(original.file, moved.file);
    const id = (await service.importManual({})).addedId;
    const otherId = (await service.importManual({})).addedId;
    fs.rmSync(original.file);
    assert.equal((await service.list()).apps[0].availability, "missing");

    queue.exe.push(moved.file); // already used by the second entry
    const dup = await service.relink({}, id);
    assert.equal(dup.error.code, "duplicate");

    const spare = makeProbeApp(dir, "probe-spare");
    queue.exe.push(spare.file);
    const fixed = await service.relink({}, id);
    assert.equal(fixed.ok, true);
    const entry = fixed.apps.find((a) => a.id === id);
    assert.equal(entry.availability, "available");
    assert.equal(entry.executablePath, spare.file);
    assert.equal(fixed.apps.find((a) => a.id === otherId).executablePath, moved.file);
  } finally {
    cleanup(dir);
  }
});

test("reorder accepts only an exact permutation and persists", async () => {
  const dir = tmp();
  try {
    const a = makeProbeApp(dir, "probe-a");
    const b = makeProbeApp(dir, "probe-b");
    const c = makeProbeApp(dir, "probe-c");
    const { service, queue } = makeService(dir);
    queue.exe.push(a.file, b.file, c.file);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await service.importManual({})).addedId);

    for (const bad of [[ids[0]], [ids[0], ids[0], ids[1]], [ids[0], ids[1], "nope"], "x", null, [...ids, "extra"]]) {
      assert.equal((await service.reorder(bad)).ok, false);
    }
    const r = await service.reorder([ids[2], ids[0], ids[1]]);
    assert.deepEqual(r.apps.map((x) => x.name), ["probe-c", "probe-a", "probe-b"]);
    const restarted = makeService(dir);
    assert.deepEqual((await restarted.service.list()).apps.map((x) => x.name), ["probe-c", "probe-a", "probe-b"]);
  } finally {
    cleanup(dir);
  }
});

test("removing an application deletes only the list entry, never the program", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir);
    const { service, queue } = makeService(dir);
    queue.exe.push(app.file);
    const id = (await service.importManual({})).addedId;
    const r = await service.remove(id);
    assert.equal(r.apps.length, 0);
    assert.equal(fs.existsSync(app.file), true);
    assert.equal((await service.remove(id)).error.code, "not-found");
    assert.equal((await service.launch(id)).error.code, "not-found");
  } finally {
    cleanup(dir);
  }
});

test("history is bounded and can be cleared", async () => {
  const dir = tmp();
  try {
    const app = makeProbeApp(dir, "probe-h", "0");
    const { service, queue, store } = makeService(dir);
    queue.exe.push(app.file);
    await service.importManual({});
    for (let i = 0; i < 130; i++) store.history.push({ appId: "x", name: "n", at: i + 1, outcome: "launched", error: null });
    store.save();
    assert.equal(service.history().history.length, 100);
    assert.equal(service.clearHistory().ok, true);
    assert.equal(service.history().history.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("discovered import uses only ids from the main-process scan; renderer-supplied paths are impossible", async () => {
  const dir = tmp();
  try {
    const found = { name: "Found App", executablePath: "C:\\Apps\\found.exe", args: ["--a"], shortcutPath: "x.lnk" };
    const winStore = new NativeAppStore(path.join(dir, "native-apps.json"), "win32");
    let approveDiscoveredArgs = false;
    const winService = createNativeAppService({
      store: winStore,
      platform: "win32",
      spawn: () => { throw new Error("spawn must not be called during discovery or import"); },
      inspect: (p) => {
        const r = v.validateExecutablePathSyntax(p, "win32");
        return r.ok ? { ok: true, path: r.path, realPath: r.path } : { ok: false, status: "invalid", error: r.error };
      },
      readShortcut: () => ({ target: found.executablePath, args: "--a" }),
      startMenuRoots: () => [dir],
      chooseExecutable: async () => null,
      chooseShortcut: async () => null,
      confirm: async () => approveDiscoveredArgs,
      getIcon: async () => null,
    });
    fs.writeFileSync(path.join(dir, "Found App.lnk"), "");

    assert.equal((await winService.importDiscovered(["C:\\Windows\\System32\\calc.exe"])).error.code, "scan-expired");

    const scan = await winService.discover();
    assert.equal(scan.ok, true);
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.candidates[0].alreadyImported, false);
    assert.equal(winStore.apps.length, 0, "scanning does not import anything");

    const evil = await winService.importDiscovered(["C:\\Windows\\System32\\calc.exe", "not-a-real-candidate"]);
    assert.equal(evil.apps.length, 0);
    assert.equal(evil.failed.length, 2);

    const denied = await winService.importDiscovered([scan.candidates[0].candidateId]);
    assert.equal(denied.imported.length, 0);
    assert.equal(denied.apps.length, 0);
    assert.match(denied.failed[0].message, /not approved/);
    assert.equal(winStore.apps.length, 0, "declining launch arguments must not import the app");

    approveDiscoveredArgs = true;
    const ok = await winService.importDiscovered([scan.candidates[0].candidateId]);
    assert.deepEqual(ok.imported, ["Found App"]);
    assert.equal(ok.apps[0].source, "discovered");
    assert.deepEqual(ok.apps[0].args, ["--a"]);

    const rescan = await winService.discover();
    assert.equal(rescan.candidates[0].alreadyImported, true);
    const dup = await winService.importDiscovered([rescan.candidates[0].candidateId]);
    assert.equal(dup.failed[0].duplicate, true);
    assert.equal(dup.apps.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("shortcut import reads the .lnk target, keeps its arguments and refuses non-program shortcuts", async () => {
  const dir = tmp();
  try {
    const store = new NativeAppStore(path.join(dir, "native-apps.json"), "win32");
    const queue = [];
    let approveShortcutArgs = false;
    const shortcuts = {
      "Viewer.lnk": { target: "C:\\Apps\\viewer.exe", args: '--open "C:\\My Docs"' },
      "Docs.lnk": { target: "C:\\Users\\me\\Documents\\notes.txt", args: "" },
      "Shell.lnk": { target: "C:\\Windows\\System32\\cmd.exe", args: "/c calc" },
      "Empty.lnk": { target: "", args: "" },
    };
    const service = createNativeAppService({
      store, platform: "win32",
      spawn: () => { throw new Error("must not launch"); },
      inspect: (p) => {
        const r = v.validateExecutablePathSyntax(p, "win32");
        return r.ok ? { ok: true, path: r.path, realPath: r.path } : { ok: false, status: "invalid", error: r.error };
      },
      readShortcut: (lnk) => shortcuts[path.win32.basename(lnk)],
      startMenuRoots: () => [],
      chooseExecutable: async () => null,
      chooseShortcut: async () => queue.shift() ?? null,
      confirm: async () => approveShortcutArgs,
      getIcon: async () => null,
    });
    queue.push("C:\\Users\\me\\Viewer.lnk");
    const denied = await service.importShortcut({});
    assert.equal(denied.ok, true);
    assert.equal(denied.cancelled, true);
    assert.equal(denied.apps.length, 0);
    assert.equal(store.apps.length, 0, "declining shortcut arguments must not import the app");

    approveShortcutArgs = true;
    queue.push("C:\\Users\\me\\Viewer.lnk");
    const ok = await service.importShortcut({});
    assert.equal(ok.ok, true);
    assert.equal(ok.apps[0].name, "Viewer");
    assert.equal(ok.apps[0].source, "shortcut");
    assert.deepEqual(ok.apps[0].args, ["--open", "C:\\My Docs"]);
    for (const lnk of ["Docs.lnk", "Shell.lnk", "Empty.lnk"]) {
      queue.push(`C:\\Users\\me\\${lnk}`);
      assert.equal((await service.importShortcut({})).ok, false, lnk);
    }
    queue.push("C:\\Users\\me\\notashortcut.txt");
    assert.equal((await service.importShortcut({})).error.code, "invalid-path");
    assert.equal(store.apps.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("unsupported platforms refuse every operation rather than pretending", async () => {
  const dir = tmp();
  try {
    const store = new NativeAppStore(path.join(dir, "native-apps.json"), "darwin");
    const service = createNativeAppService({
      store, platform: "darwin",
      spawn: () => { throw new Error("must not spawn"); },
      inspect: () => ({ ok: false, status: "invalid", error: { code: "unsupported-platform", message: "x" } }),
      readShortcut: () => ({}), startMenuRoots: () => [], chooseExecutable: async () => "/x", chooseShortcut: async () => "/x",
      confirm: async () => true, getIcon: async () => null,
    });
    for (const fn of [() => service.discover(), () => service.importManual({}), () => service.launch("abcdefgh")]) {
      const r = await fn();
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "unsupported-platform");
    }
    const list = await service.list();
    assert.equal(list.support.supported, false);
  } finally {
    cleanup(dir);
  }
});

/* ============================ IPC / preload surface ============================ */

function fakeElectron(dir) {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    app: {
      getPath: () => dir,
      getAppPath: () => dir,
      getFileIcon: async () => ({ isEmpty: () => true, toDataURL: () => "" }),
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { readShortcutLink: () => ({ target: "", args: "" }) },
    BrowserWindow: { fromWebContents: () => null },
  };
}

test("IPC handlers trust only the exact app page in its main frame", async () => {
  const dir = tmp();
  try {
    const fake = fakeElectron(dir);
    registerNativeAppIpc(fake);

    const expected = path.join(dir, "dist", "index.html");
    const goodFrame = { url: pathToFileURL(expected).href };
    const good = { senderFrame: goodFrame, sender: { mainFrame: goodFrame } };
    const evilFrame = { url: "https://evil.example/page" };
    const evil = { senderFrame: evilFrame, sender: { mainFrame: evilFrame } };
    const noFrame = { sender: {} };
    const foreignFrame = { url: pathToFileURL(path.join(dir, "evil.html")).href };
    const foreignFile = { senderFrame: foreignFrame, sender: { mainFrame: foreignFrame } };
    const topFrame = { url: pathToFileURL(expected).href };
    const subFrame = { url: pathToFileURL(expected).href };
    const subframeCaller = { senderFrame: subFrame, sender: { mainFrame: topFrame } };
    const hostileQueryFrame = { url: `${pathToFileURL(expected).href}?unexpected=1` };
    const hostileQuery = { senderFrame: hostileQueryFrame, sender: { mainFrame: hostileQueryFrame } };
    const companionFrame = { url: `${pathToFileURL(expected).href}?exileWindow=companion` };
    const companion = { senderFrame: companionFrame, sender: { mainFrame: companionFrame } };
    const hashFrame = { url: `${pathToFileURL(expected).href}#unexpected` };
    const hashCaller = { senderFrame: hashFrame, sender: { mainFrame: hashFrame } };

    for (const channel of Object.values(CHANNELS)) {
      const handler = fake.handlers.get(channel);
      assert.equal(typeof handler, "function", channel);
      for (const [caller, label] of [
        [evil, "remote page"],
        [noFrame, "missing frame"],
        [foreignFile, "foreign local file"],
        [subframeCaller, "subframe"],
        [hostileQuery, "unexpected query"],
        [hashCaller, "URL fragment"],
      ]) {
        assert.equal((await handler(caller)).error.code, "forbidden", `${channel}: ${label}`);
      }
    }

    assert.equal((await fake.handlers.get(CHANNELS.list)(good)).ok, true);
    assert.equal((await fake.handlers.get(CHANNELS.list)(companion)).ok, true);
    assert.equal(isTrustedSender(good, expected, process.platform), true);
    assert.equal(isTrustedSender(foreignFile, expected, process.platform), false);
    assert.equal(isTrustedSender(subframeCaller, expected, process.platform), false);
    assert.equal(isTrustedSender({ senderFrame: { url: "http://localhost:8080/" } }, expected), false);
  } finally {
    cleanup(dir);
  }
});

test("IPC handlers validate argument shapes and never throw across the bridge", async () => {
  const dir = tmp();
  try {
    const fake = fakeElectron(dir);
    registerNativeAppIpc(fake);
    const goodFrame = { url: pathToFileURL(path.join(dir, "dist", "index.html")).href };
    const good = { senderFrame: goodFrame, sender: { mainFrame: goodFrame } };
    const call = (ch, ...a) => fake.handlers.get(CHANNELS[ch])(good, ...a);
    assert.equal((await call("launch", { toString() { return "x"; } })).error.code, "invalid-request");
    assert.equal((await call("launch", "a".repeat(65))).error.code, "invalid-request");
    assert.equal((await call("launch", "")).error.code, "invalid-request");
    assert.equal((await call("remove", 5)).error.code, "invalid-request");
    assert.equal((await call("relink", null)).error.code, "invalid-request");
    assert.equal((await call("update", undefined, {})).error.code, "invalid-request");
    assert.equal((await call("importDiscovered", "nope")).error.code, "invalid-request");
    assert.equal((await call("reorder", "nope")).ok, false);
    assert.equal((await call("launch", "does-not-exist")).error.code, process.platform === "linux" || process.platform === "win32" ? "not-found" : "unsupported-platform");
  } finally {
    cleanup(dir);
  }
});

test("the preload bridge exposes exactly the registered channels and nothing generic", () => {
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const used = new Set([...preload.matchAll(/"(exile:apps:[a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), Object.values(CHANNELS).sort());
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\b[^,]/, "ipcRenderer is never exposed directly");
  assert.doesNotMatch(preload, /(child_process|require\("fs"\)|require\("node:fs"\)|shell\.|exec\()/);
  const exposed = preload.match(/exposeInMainWorld\("exileDesktop", \{([\s\S]*?)\n\}\);/)[1];
  assert.doesNotMatch(exposed, /\bipcRenderer\s*[,}]/);
});

test("main process keeps context isolation and the sandbox on for every window", () => {
  const main = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  assert.equal((main.match(/contextIsolation: true/g) ?? []).length, 2);
  assert.equal((main.match(/sandbox: true/g) ?? []).length, 2);
  assert.equal((main.match(/nodeIntegration: false/g) ?? []).length, 2);
  assert.doesNotMatch(main, /contextIsolation: false|sandbox: false|nodeIntegration: true|webSecurity: false|enableRemoteModule/);
});
