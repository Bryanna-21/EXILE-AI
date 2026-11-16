/**
 * EXILE permission gateway.
 * Approval grants are bound to one task, step, tool, risk and canonical argument
 * set. A decision records consent; the execution gate consumes the grant once.
 */
import crypto from "node:crypto";

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Approval arguments must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Approval arguments must not be circular.");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Approval arguments must contain plain objects.");
    }
    if (seen.has(value)) throw new TypeError("Approval arguments must not be circular.");
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError("Approval arguments must not contain reserved keys.");
      }
      if (value[key] === undefined) throw new TypeError("Approval arguments must not contain undefined values.");
      result[key] = canonicalize(value[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError("Approval arguments must be JSON-compatible.");
}

const MAX_TRACKED_REQUESTS = 500;

export class PermissionGateway {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.requests = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Drop settled/expired requests once the table grows, oldest first. */
  _prune() {
    if (this.requests.size < MAX_TRACKED_REQUESTS) return;
    for (const [id, r] of this.requests) {
      if (this.requests.size < MAX_TRACKED_REQUESTS * 0.8) break;
      if (r.decision !== null || r.consumed || this._isExpired(r)) this.requests.delete(id);
    }
    if (this.requests.size >= MAX_TRACKED_REQUESTS) {
      throw Object.assign(new Error("Too many pending approvals; resolve or cancel existing ones."), { statusCode: 429 });
    }
  }

  static hashArgs(args) {
    const canonical = JSON.stringify(canonicalize(args ?? {}));
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  createRequest({ taskId, stepId, tool, args, risk }) {
    if (!taskId || !stepId || !tool) throw new TypeError("Approval requires taskId, stepId and tool.");
    this._prune();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const record = {
      id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      taskId, stepId, tool, argsHash: PermissionGateway.hashArgs(args), risk,
      summary: describeOperation(tool, args, risk),
      createdAt: new Date(this.now()).toISOString(), decidedAt: null, decision: null,
      consumed: false,
    };
    this.requests.set(id, record);
    return { requestId: id, token, summary: record.summary, tool, risk, expiresAt: new Date(this.now() + this.ttlMs).toISOString() };
  }

  pendingForTask(taskId) {
    return [...this.requests.values()]
      .filter((r) => r.taskId === taskId && r.decision === null)
      .map(({ tokenHash, ...safe }) => ({ ...safe }));
  }

  getRequest(requestId) {
    const r = this.requests.get(String(requestId));
    if (!r) return null;
    const { tokenHash, ...safe } = r;
    return { ...safe };
  }

  /** Withdraw an approval (pending or already approved but unused). Revoked grants can never authorize execution. */
  revoke(requestId, reason = "revoked") {
    const record = this.requests.get(String(requestId));
    if (!record) return { ok: false, error: "Unknown approval request." };
    if (record.consumed) return { ok: false, error: "Approval was already used." };
    record.decision = "revoked";
    record.revokedReason = String(reason).slice(0, 200);
    record.decidedAt = new Date(this.now()).toISOString();
    return { ok: true };
  }

  /** Revoke every unused approval for a task (cancel, pause, failure, timeout). */
  revokeForTask(taskId, reason) {
    let count = 0;
    for (const record of this.requests.values()) {
      if (record.taskId === taskId && !record.consumed && record.decision !== "revoked" && record.decision !== "refused") {
        record.decision = "revoked";
        record.revokedReason = String(reason ?? "task ended").slice(0, 200);
        record.decidedAt = new Date(this.now()).toISOString();
        count++;
      }
    }
    return count;
  }

  _isExpired(record) {
    return this.now() - Date.parse(record.createdAt) > this.ttlMs;
  }

  decide({ requestId, token, approved, taskId, stepId, tool, args }) {
    const record = this.requests.get(String(requestId));
    if (!record) return { ok: false, error: "Unknown approval request." };
    if (record.decision === "revoked") return { ok: false, error: "This approval was revoked." };
    if (record.decision !== null || record.consumed) return { ok: false, error: "This approval was already answered or consumed." };
    if (this._isExpired(record)) {
      record.decision = "expired";
      return { ok: false, error: "Approval expired; request a new approval." };
    }
    if (record.taskId !== taskId || record.stepId !== stepId || record.tool !== tool) {
      return { ok: false, error: "Approval does not match this task/step/tool." };
    }
    const suppliedHash = crypto.createHash("sha256").update(String(token ?? "")).digest();
    const expectedHash = Buffer.from(record.tokenHash, "hex");
    if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      return { ok: false, error: "Invalid approval token." };
    }
    let argsHash;
    try { argsHash = PermissionGateway.hashArgs(args); }
    catch (error) { return { ok: false, error: error.message }; }
    if (argsHash !== record.argsHash) {
      record.decision = "expired";
      record.decidedAt = new Date(this.now()).toISOString();
      return { ok: false, error: "Arguments differ from the approved operation. A new approval is required." };
    }
    record.decision = approved === true ? "approved" : "refused";
    record.decidedAt = new Date(this.now()).toISOString();
    return { ok: true, decision: record.decision };
  }

  authorizeExecution({ requestId, taskId, stepId, tool, args }) {
    const record = this.requests.get(String(requestId));
    if (!record) return { allowed: false, error: "No such approval request." };
    if (record.decision === "revoked") return { allowed: false, error: "Approval was revoked." };
    if (record.decision !== "approved") return { allowed: false, error: "Operation has not been approved." };
    if (record.consumed) return { allowed: false, error: "Approval already used; approvals are single-use." };
    if (this._isExpired(record)) {
      record.decision = "expired";
      return { allowed: false, error: "Approval expired; a new approval is required." };
    }
    if (record.taskId !== taskId || record.stepId !== stepId || record.tool !== tool) {
      return { allowed: false, error: "Approval is bound to a different task/step/tool." };
    }
    let argsHash;
    try { argsHash = PermissionGateway.hashArgs(args); }
    catch (error) { return { allowed: false, error: error.message }; }
    if (argsHash !== record.argsHash) return { allowed: false, error: "Approval is bound to different arguments." };
    record.consumed = true;
    return { allowed: true };
  }
}

export function describeOperation(tool, args, risk) {
  const a = args ?? {};
  if (tool === "send_whatsapp_message") {
    const recipient = String(a.to ?? "").replace(/[\r\n"]/g, "").slice(0, 100);
    return `Send a WhatsApp message to "${recipient}". Message content is hidden here; this leaves the device and cannot be unsent.`;
  }
  return `Run ${String(tool).slice(0, 100)} (${risk}) with the exact arguments shown in the approval details.`;
}

export const APPROVAL_REQUIRED_RISKS = new Set(["sensitive", "destructive"]);
