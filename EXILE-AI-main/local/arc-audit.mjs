/**
 * Append-only audit trail for ARC actions that change the machine (process termination).
 * One JSON object per line, owner-only permissions. Never records command lines, paths or secrets:
 * only pid, process name, outcome and the reason a request was refused.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;

export function createArcAudit(dir, { now = () => new Date() } = {}) {
  const file = path.join(dir, "arc-audit.jsonl");
  return {
    file,
    record(entry) {
      const line = JSON.stringify({
        at: now().toISOString(),
        action: String(entry.action ?? "unknown").slice(0, 40),
        pid: Number.isSafeInteger(entry.pid) ? entry.pid : null,
        name: typeof entry.name === "string" ? entry.name.slice(0, 80) : null,
        outcome: entry.ok ? "done" : "refused",
        method: typeof entry.method === "string" ? entry.method.slice(0, 40) : null,
        reason: entry.ok ? null : String(entry.error ?? "unknown").slice(0, 200),
        confirmed: entry.confirmed === true,
        forceConfirmed: entry.forceConfirmed === true,
      });
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
        fs.appendFileSync(file, line + "\n", { mode: 0o600 });
        return true;
      } catch {
        return false; // auditing must never block or crash the request path
      }
    },
    read(limit = 100) {
      try {
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
