// Guards the removal of the Lovable platform tooling and the env validation contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}

test("no Lovable platform tooling in manifests, build config, html or app source", () => {
  const files = ["package.json", "package-lock.json", "vite.config.ts", "index.html", "README.md", ...walk("src")];
  const hits = files.filter((f) => /lovable/i.test(read(f)));
  assert.deepEqual(hits, []);
});

test("lockfile resolves only from the public registry (or the one known git dependency)", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const odd = Object.entries(lock.packages)
    .map(([k, v]) => [k, v.resolved])
    .filter(([, r]) => r && !r.startsWith("https://registry.npmjs.org/") && !r.includes("whiskeysockets/libsignal-node"));
  assert.deepEqual(odd, []);
});

test("every package in package.json is present in the lockfile root entry", () => {
  const pkg = JSON.parse(read("package.json"));
  const rootEntry = JSON.parse(read("package-lock.json")).packages[""];
  assert.deepEqual(rootEntry.dependencies, pkg.dependencies);
  assert.deepEqual(rootEntry.devDependencies, pkg.devDependencies);
});

test("the only remaining gateway references are the optional, user-keyed AI gateway provider", () => {
  const allowed = new Set(["local/server.mjs", "local/README-LOCAL.md", ".lovable/plan.md",
    "supabase/functions/exile-health/index.ts", "supabase/functions/exile-image/index.ts",
    "supabase/functions/exile-analyze/index.ts", "supabase/functions/exile-chat/index.ts"].map((f) => path.normalize(f)));
  const files = [...walk("local"), ...walk("supabase"), ...walk(".lovable")].filter((f) => /\.(mjs|ts|md|json)$/.test(f));
  const unexpected = files.filter((f) => /lovable/i.test(read(f)) && !allowed.has(path.normalize(f)));
  assert.deepEqual(unexpected, []);
});

const { supabaseConfigProblems, getSupabaseConfig, EnvConfigError } = await import("../src/lib/env.ts");

test("env: missing values are named, nothing is invented", () => {
  const p = supabaseConfigProblems({});
  assert.equal(p.length, 2);
  assert.match(p[0], /VITE_SUPABASE_URL/);
  assert.match(p[1], /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.throws(() => getSupabaseConfig({}), (e) => e instanceof EnvConfigError && /\.env\.example/.test(e.message));
});

test("env: malformed URL and service-role keys are rejected", () => {
  assert.match(supabaseConfigProblems({ VITE_SUPABASE_URL: "not a url", VITE_SUPABASE_PUBLISHABLE_KEY: "k" })[0], /valid URL/);
  assert.match(supabaseConfigProblems({ VITE_SUPABASE_URL: "ftp://x.co", VITE_SUPABASE_PUBLISHABLE_KEY: "k" })[0], /http\(s\)/);
  assert.match(supabaseConfigProblems({ VITE_SUPABASE_URL: "https://a.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "my_service_role_key" })[0], /service-role/);
});

test("env: valid configuration is returned trimmed", () => {
  assert.deepEqual(getSupabaseConfig({ VITE_SUPABASE_URL: " https://a.supabase.co ", VITE_SUPABASE_PUBLISHABLE_KEY: " pk " }), { url: "https://a.supabase.co", publishableKey: "pk" });
});
