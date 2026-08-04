#!/usr/bin/env node
/**
 * EXILE local API server.
 *
 * Runs alongside the Vite app when you self-host EXILE. It reads provider API
 * keys from .env and exposes the same endpoints the hosted build uses:
 *   POST /exile-chat     -> streaming SSE chat completions
 *   POST /exile-analyze  -> streaming SSE document/image analysis
 *   POST /exile-image    -> image generation (SSE frames)
 *   GET  /health         -> which providers are configured
 *
 * Supports up to 200 keys: any env var ending in _API_KEY is registered.
 * Minimum required: 2 keys (one chat provider + one fallback, or Ollama).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// ---------- .env loader (no dependencies) ----------
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (v && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.EXILE_PORT || 8787);

// ---------- provider registry ----------
const PROVIDERS = [
  { id: "openai",     key: "OPENAI_API_KEY",     base: "https://api.openai.com/v1",              chat: "gpt-4o-mini",                 image: "gpt-image-1" },
  { id: "groq",       key: "GROQ_API_KEY",       base: "https://api.groq.com/openai/v1",         chat: "llama-3.3-70b-versatile" },
  { id: "openrouter", key: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1",           chat: "openai/gpt-4o-mini" },
  { id: "together",   key: "TOGETHER_API_KEY",   base: "https://api.together.xyz/v1",            chat: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "deepseek",   key: "DEEPSEEK_API_KEY",   base: "https://api.deepseek.com/v1",            chat: "deepseek-chat" },
  { id: "mistral",    key: "MISTRAL_API_KEY",    base: "https://api.mistral.ai/v1",              chat: "mistral-large-latest" },
  { id: "xai",        key: "XAI_API_KEY",        base: "https://api.x.ai/v1",                    chat: "grok-2-latest" },
  { id: "perplexity", key: "PERPLEXITY_API_KEY", base: "https://api.perplexity.ai",              chat: "sonar" },
  { id: "gemini",     key: "GEMINI_API_KEY",     base: "https://generativelanguage.googleapis.com/v1beta/openai", chat: "gemini-2.5-flash" },
  { id: "lovable",    key: "LOVABLE_API_KEY",    base: "https://ai.gateway.lovable.dev/v1",      chat: "google/gemini-3.6-flash",     image: "google/gemini-3.1-flash-image" },
];

const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";

function available() {
  return PROVIDERS.filter((p) => !!process.env[p.key]);
}

/** Extra keys: every *_API_KEY in .env, up to 200. */
function allKeys() {
  return Object.keys(process.env).filter((k) => k.endsWith("_API_KEY")).slice(0, 200);
}

function chatOrder() {
  const preferred = (process.env.EXILE_PRIMARY_PROVIDER || "").trim();
  const list = available();
  if (!preferred) return list;
  return [...list.filter((p) => p.id === preferred), ...list.filter((p) => p.id !== preferred)];
}

// ---------- helpers ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(res, status, data) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 25 * 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function pipeSSE(upstream, res) {
  res.writeHead(200, {
    ...CORS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
  }
  res.end();
}

/** Ollama -> OpenAI-shaped SSE, so the browser code needs no changes. */
async function ollamaStream(messages, res) {
  const model = process.env.OLLAMA_MODEL || "llama3.2";
  const upstream = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!upstream.ok || !upstream.body) throw new Error(`Ollama HTTP ${upstream.status}`);

  res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const delta = j.message?.content;
        if (delta) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
      } catch { /* ignore partial lines */ }
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const SYSTEM_PROMPT =
  process.env.EXILE_SYSTEM_PROMPT ||
  "You are EXILE — EXiled Intelligence, Liberated from Everything. Your AI. Your PC. Your rules. " +
  "Speak with dry wit and precision, address the user as Sir when it fits, and stay concise unless depth is asked for.";

async function handleChat(body, res) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...(body.messages || [])];
  const providers = chatOrder();
  const errors = [];

  for (const p of providers) {
    try {
      const upstream = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env[p.key]}`,
        },
        body: JSON.stringify({
          model: body.model || process.env[`${p.id.toUpperCase()}_MODEL`] || p.chat,
          messages,
          stream: true,
        }),
      });
      if (!upstream.ok || !upstream.body) {
        errors.push(`${p.id}: HTTP ${upstream.status} ${await upstream.text().catch(() => "")}`.slice(0, 300));
        continue;
      }
      console.log(`[exile] chat via ${p.id}`);
      return pipeSSE(upstream, res);
    } catch (e) {
      errors.push(`${p.id}: ${e.message}`);
    }
  }

  // Last resort: local Ollama
  try {
    console.log("[exile] chat via ollama");
    return await ollamaStream(messages, res);
  } catch (e) {
    errors.push(`ollama: ${e.message}`);
  }

  json(res, 502, { error: "No provider could answer.", details: errors });
}

async function handleImage(body, res) {
  const p = available().find((x) => x.image);
  if (!p) return json(res, 400, { error: "No image-capable key configured (OPENAI_API_KEY or LOVABLE_API_KEY)." });

  const upstream = await fetch(`${p.base}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[p.key]}` },
    body: JSON.stringify({ model: body.model || p.image, prompt: body.prompt, stream: true }),
  });
  if (!upstream.ok) {
    return json(res, upstream.status, { error: await upstream.text().catch(() => "Image request failed") });
  }
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) return pipeSSE(upstream, res);

  // Non-streaming providers: re-emit as a single SSE frame.
  const data = await upstream.json();
  const b64 = data?.data?.[0]?.b64_json;
  res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream" });
  if (b64) {
    res.write(`event: image_generation.completed\ndata: ${JSON.stringify({ b64_json: b64 })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/health") {
      return json(res, 200, {
        status: "online",
        providers: available().map((p) => p.id),
        keysDetected: allKeys().length,
        ollama: OLLAMA,
      });
    }
    if (req.method !== "POST") return json(res, 404, { error: "Not found" });

    const body = await readBody(req);
    if (url.pathname === "/exile-chat" || url.pathname === "/exile-analyze") return handleChat(body, res);
    if (url.pathname === "/exile-image") return handleImage(body, res);
    return json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[exile] error:", e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  const keys = allKeys();
  console.log(`\n  EXILE local API  ->  http://localhost:${PORT}`);
  console.log(`  Providers ready: ${available().map((p) => p.id).join(", ") || "none (Ollama fallback)"}`);
  console.log(`  Keys detected:   ${keys.length} / 200 max`);
  if (keys.length < 2) console.log("  ! Add at least 2 API keys in .env for redundancy.\n");
  else console.log("");
});
