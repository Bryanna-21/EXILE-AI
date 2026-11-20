/**
 * HTTP routes for the artifact engine (mounted at /artifacts by local/server.mjs).
 *
 * Access control:
 *   - loopback Host header only (blocks DNS rebinding),
 *   - Origin must be absent, "null", file:// or a localhost origin (same rule as /tasks and /arc),
 *   - when a shared secret is configured (EXILE_LOCAL_AUTH_SECRET), the x-exile-local-auth header
 *     must match it (constant-time compare),
 *   - artifacts are addressed only by validated ids; clients never supply file paths.
 * Responses never contain API keys, absolute paths or stack traces.
 */
import crypto from "node:crypto";
import { isArtifactId } from "./store.mjs";
import { toErrorCode, redact } from "./errors.mjs";
import { getFormat } from "./formats.mjs";

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const STATUS = {
  INVALID_INPUT: 400, FORBIDDEN: 403, NOT_FOUND: 404, TOO_LARGE: 413, VALIDATION_FAILURE: 422,
  PROVIDER_FAILURE: 502, DELIVERY_FAILURE: 502, ENGINE_UNAVAILABLE: 503, TIMEOUT: 504, GENERATION_FAILURE: 500,
};

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isLocalRequest(req) {
  const origin = req.headers.origin;
  const originOk = !origin || origin === "null" || origin === "file://" || LOCAL_ORIGIN.test(origin);
  const hostOk = !req.headers.host || LOCAL_HOST.test(req.headers.host);
  return originOk && hostOk;
}

function secretOk(req, secret) {
  if (!secret) return true;
  const got = String(req.headers["x-exile-local-auth"] || "");
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    ...(origin && LOCAL_ORIGIN.test(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "content-type, x-exile-local-auth, accept",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };
}

function send(req, res, status, payload) {
  res.writeHead(status, { ...corsHeaders(req), "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { code: "TOO_LARGE" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { code: "INVALID_INPUT" });
  }
}

function statusFor(code) {
  return STATUS[code] || 500;
}

export function createArtifactApiHandler({ engine, getSecret = () => process.env.EXILE_LOCAL_AUTH_SECRET || "" }) {
  const ID = "(art_[0-9a-f]{24})";

  /** Run an engine call that returns an ArtifactResult, optionally streaming real stage events as SSE. */
  async function runStreaming(req, res, run) {
    const wantsStream = String(req.headers.accept || "").includes("text/event-stream");
    if (!wantsStream) {
      const result = await run(undefined);
      return send(req, res, result.success === false ? statusFor(result.code) : 200, { ok: result.success !== false, result });
    }
    res.writeHead(200, { ...corsHeaders(req), "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const result = await run((e) => write("progress", { stage: e.stage, message: e.message, t: e.t, ...(e.attempt !== undefined ? { attempt: e.attempt } : {}) }));
    write("result", { ok: result.success !== false, result });
    res.end();
  }

  return async function handleArtifactApi(req, res, url) {
    const path = url.pathname;
    if (path !== "/artifacts" && !path.startsWith("/artifacts/")) return false;

    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); res.end(); return true; }
    if (!isLocalRequest(req)) { send(req, res, 403, { ok: false, error: "Artifact API is restricted to the local app." }); return true; }
    if (!secretOk(req, getSecret())) { send(req, res, 401, { ok: false, error: "Missing or invalid local authorization." }); return true; }

    try {
      const m = (re) => path.match(re);
      if (req.method === "GET" && path === "/artifacts/capabilities") return send(req, res, 200, { ok: true, ...engine.capabilities() }), true;
      if (req.method === "GET" && path === "/artifacts/audit") return send(req, res, 200, { ok: true, events: await engine.store.readAudit(100) }), true;
      if (req.method === "GET" && path === "/artifacts") {
        const kind = url.searchParams.get("kind") || undefined;
        return send(req, res, 200, { ok: true, artifacts: await engine.list({ kind, limit: Number(url.searchParams.get("limit")) || 200 }) }), true;
      }
      let g;
      if (req.method === "GET" && (g = m(/^\/artifacts\/jobs\/(job_[0-9a-f]{16})$/))) {
        const job = engine.getJob(g[1]);
        return send(req, res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: "Job not found." }), true;
      }

      if (req.method === "POST" && path === "/artifacts") {
        const body = await readJson(req);
        await runStreaming(req, res, (onEvent) => engine.create({ format: body.format, spec: body.spec, prompt: body.prompt, name: body.name, onEvent }));
        return true;
      }
      if (req.method === "POST" && path === "/artifacts/package") {
        const body = await readJson(req);
        await runStreaming(req, res, (onEvent) => engine.packageArtifacts(body.ids, { name: typeof body.name === "string" ? body.name.slice(0, 80) : undefined, onEvent }));
        return true;
      }
      if (req.method === "POST" && path === "/artifacts/ai-image") {
        const body = await readJson(req);
        await runStreaming(req, res, (onEvent) => engine.createAiImage({ prompt: body.prompt, width: body.width, height: body.height, steps: body.steps, format: body.format, name: body.name, onEvent }));
        return true;
      }

      if ((g = m(new RegExp(`^/artifacts/${ID}$`)))) {
        if (req.method === "GET") return send(req, res, 200, { ok: true, artifact: await engine.describe(g[1]) }), true;
        if (req.method === "DELETE") {
          const out = await engine.delete(g[1], { confirm: url.searchParams.get("confirm") });
          return send(req, res, 200, { ok: true, ...out }), true;
        }
      }
      if (req.method === "GET" && (g = m(new RegExp(`^/artifacts/${ID}/preview$`)))) {
        const v = url.searchParams.get("version");
        return send(req, res, 200, { ok: true, preview: await engine.preview(g[1], v ? Number(v) : undefined) }), true;
      }
      if (req.method === "GET" && (g = m(new RegExp(`^/artifacts/${ID}/download$`)))) {
        const v = url.searchParams.get("version");
        const { meta, buffer, record } = await engine.read(g[1], v ? Number(v) : undefined);
        const inline = url.searchParams.get("inline") === "1" && engine.inlineAllowed(meta.mime);
        const fmt = getFormat(meta.format);
        const safeName = meta.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          ...corsHeaders(req),
          "Content-Type": fmt.mime,
          "Content-Length": buffer.length,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          // Whatever the file contains, it can never run script or load anything when opened.
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; sandbox",
          "X-Artifact-Version": String(record.version),
          "X-Artifact-Sha256": record.sha256,
        });
        res.end(buffer);
        return true;
      }
      if (req.method === "POST" && (g = m(new RegExp(`^/artifacts/${ID}/edit$`)))) {
        const body = await readJson(req);
        await runStreaming(req, res, (onEvent) => engine.edit(g[1], { spec: body.spec, operations: body.operations, quality: body.quality, onEvent }));
        return true;
      }
      if (req.method === "POST" && (g = m(new RegExp(`^/artifacts/${ID}/convert$`)))) {
        const body = await readJson(req);
        await runStreaming(req, res, (onEvent) => engine.convert(g[1], body.format, { ...(body.options || {}), name: body.name, onEvent }));
        return true;
      }
      if (req.method === "POST" && (g = m(new RegExp(`^/artifacts/${ID}/variations$`)))) {
        const body = await readJson(req);
        const results = await engine.variations(g[1], { count: body.count });
        return send(req, res, 200, { ok: results.every((r) => r.success), results }), true;
      }
      if (req.method === "POST" && (g = m(new RegExp(`^/artifacts/${ID}/deliver$`)))) {
        const body = await readJson(req);
        const result = await engine.deliver(g[1], { channel: body.channel || "whatsapp", to: body.to, caption: typeof body.caption === "string" ? body.caption.slice(0, 1000) : "", version: body.version });
        const status = result.success ? 200 : result.state === "failed" ? 502 : statusFor(result.code);
        return send(req, res, status, { ok: !!result.success, result }), true;
      }
      send(req, res, 404, { ok: false, error: "Not found." });
      return true;
    } catch (error) {
      const code = toErrorCode(error);
      const status = error.code === "TOO_LARGE" ? 413 : statusFor(code);
      if (!res.headersSent) send(req, res, status, { ok: false, code, error: redact(error.message) });
      else res.end();
      return true;
    }
  };
}

export { isArtifactId };
