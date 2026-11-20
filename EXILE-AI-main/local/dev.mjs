#!/usr/bin/env node
/** Starts the EXILE local API server and the Vite UI together, sharing a per-launch API secret. */
import { spawn } from "node:child_process";
import crypto from "node:crypto";

// Development only: Vite exposes VITE_* values to the browser bundle, so this secret is
// visible to the dev page. That is acceptable for a loopback dev session; packaged builds
// receive the secret through Electron's preload instead (see electron/main.cjs).
const secret = crypto.randomBytes(32).toString("base64url");

const procs = [
  spawn(process.execPath, ["local/server.mjs"], { stdio: "inherit", env: { ...process.env, EXILE_LOCAL_API_SECRET: secret } }),
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
    stdio: "inherit",
    env: { ...process.env, VITE_EXILE_LOCAL_API_SECRET: secret },
  }),
];

const shutdown = () => {
  for (const p of procs) if (!p.killed) p.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
for (const p of procs) p.on("exit", shutdown);
