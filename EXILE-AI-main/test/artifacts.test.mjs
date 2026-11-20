import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../local/artifacts/store.mjs";
import { ArtifactEngine } from "../local/artifacts/engine.mjs";
import { createTextRouter } from "../local/artifacts/provider-router.mjs";
import { createArtifactApiHandler } from "../local/artifacts/api.mjs";
import { detectArtifactRequest } from "../local/artifacts/request.mjs";
import { sniffFormat } from "../local/artifacts/formats.mjs";
import { findTool } from "../local/artifacts/tools.mjs";
import sharp from "sharp";
import { sanitizeSvg, proceduralSvg } from "../local/artifacts/images.mjs";
import { validateEntryPath } from "../local/artifacts/zip-utils.mjs";
import { detectArtifactIntent } from "../src/lib/artifactIntent.ts";
import { parseSse, createArtifactClient, isFail } from "../src/lib/artifactApi.ts";

const hasFfmpeg = !!findTool("ffmpeg");
const hasOffice = !!findTool("soffice");

async function setup({ textRouter = null, senders = {}, extra = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "exile-art-"));
  const store = new ArtifactStore({ rootDir: root });
  const engine = new ArtifactEngine({ store, textRouter, senders, ...extra });
  return { root, store, engine, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
async function tempCount(root) {
  try { return (await fs.readdir(path.join(root, "tmp"))).length; } catch { return 0; }
}

const DOC = "# Quarterly Report\n\n## Summary\n\nRevenue grew **12%** in Q3.\n\n- Item one\n- Item two\n\n| Region | Sales |\n|---|---|\n| Nairobi | 120 |\n| Mombasa | 80 |\n";

test("document formats generate, validate and store with integrity metadata", async () => {
  const t = await setup();
  try {
    for (const format of ["pdf", "docx", "txt", "md", "rtf", "html"]) {
      const r = await t.engine.create({ format, spec: { content: DOC }, name: `report.${format}` });
      assert.equal(r.success, true, `${format}: ${r.error}`);
      assert.equal(r.validation.passed, true, format);
      const { buffer, record, meta } = await t.engine.read(r.artifactId);
      assert.ok(buffer.length > 20);
      assert.equal(record.sha256.length, 64);
      assert.equal(meta.format, format);
    }
    assert.equal(await tempCount(t.root), 0);
  } finally { await t.cleanup(); }
});

test("data formats: csv, json, xml, xlsx", async () => {
  const t = await setup();
  try {
    const csv = await t.engine.create({ format: "csv", spec: { columns: ["name", "=cmd"], rows: [["a, b", "=1+1"], ["c", "d"]] } });
    assert.equal(csv.success, true, csv.error);
    const text = (await t.engine.read(csv.artifactId)).buffer.toString("utf8");
    assert.ok(!/(^|,|\n)=1\+1/.test(text), "formula injection neutralised");
    const json = await t.engine.create({ format: "json", spec: { data: { a: [1, 2, 3], b: "x" } } });
    assert.equal(json.success, true, json.error);
    assert.deepEqual(JSON.parse((await t.engine.read(json.artifactId)).buffer.toString()), { a: [1, 2, 3], b: "x" });
    const bad = await t.engine.create({ format: "json", spec: { content: "{not json" } });
    assert.equal(bad.success, false);
    const xml = await t.engine.create({ format: "xml", spec: { data: { item: [{ n: 1 }, { n: 2 }] }, root: "items" } });
    assert.equal(xml.success, true, xml.error);
    const xlsx = await t.engine.create({ format: "xlsx", spec: { sheets: [{ name: "Sales", rows: [["Region", "Total"], ["Nairobi", 120], ["Mombasa", 80]] }] } });
    assert.equal(xlsx.success, true, xlsx.error);
  } finally { await t.cleanup(); }
});

test("pptx, zip and svg/png images", async () => {
  const t = await setup();
  try {
    const pptx = await t.engine.create({ format: "pptx", spec: { content: "# Deck\n\n## One\n\n- a\n- b\n\n## Two\n\n- c\n- d\n" } });
    assert.equal(pptx.success, true, pptx.error);
    const zip = await t.engine.create({ format: "zip", spec: { projectName: "demo", files: [{ path: "src/a.txt", content: "hello" }, { path: "README.md", content: "# x" }] } });
    assert.equal(zip.success, true, zip.error);
    const png = await t.engine.create({ format: "png", spec: { procedural: { type: "gradient", title: "Hi" } } });
    assert.equal(png.success, true, png.error);
    const { buffer } = await t.engine.read(png.artifactId);
    assert.equal(sniffFormat(buffer)?.id ?? sniffFormat(buffer), "png");
  } finally { await t.cleanup(); }
});

test("semantic procedural image renderers produce safe, valid PNGs", async () => {
  const t = await setup();

  const cases = [
    {
      type: "logo",
      title: "Exile Systems",
    },
    {
      type: "icon",
      title: "Lightning",
      symbol: "bolt",
    },
    {
      type: "diagram",
      title: "Deployment",
      labels: ["Build", "Test", "Release"],
    },
    {
      type: "poster",
      title: "EXILE AI",
      subtitle: "Local-first intelligence",
    },
  ];

  try {
    for (const procedural of cases) {
      const spec = {
        ...procedural,
        width: 512,
        height: 512,
        seed: 42,
      };

      const svg = sanitizeSvg(proceduralSvg(spec));
      assert.ok(svg.startsWith("<svg"), `${spec.type}: valid SVG root`);

      const result = await t.engine.create({
        format: "png",
        spec: { procedural: spec },
        name: `${spec.type}-regression.png`,
      });

      assert.equal(result.success, true, `${spec.type}: ${result.error}`);
      assert.equal(result.validation.passed, true, `${spec.type}: validation failed`);

      const { buffer, meta } = await t.engine.read(result.artifactId);
      const image = sharp(buffer);
      const dimensions = await image.metadata();

      assert.equal(dimensions.format, "png", `${spec.type}: PNG format`);
      assert.equal(dimensions.width, 512, `${spec.type}: width`);
      assert.equal(dimensions.height, 512, `${spec.type}: height`);
      assert.ok(buffer.length > 1000, `${spec.type}: non-trivial output`);

      const stats = await image.stats();
      const spread = Math.max(...stats.channels.map(channel => channel.stdev));

      assert.ok(spread > 0.5, `${spec.type}: image must not be blank`);
      assert.equal(meta.format, "png");
    }
  } finally {
    await t.cleanup();
  }
});

test("bar and line chart renderers produce valid PNGs and reject invalid data", async () => {
  const t = await setup();

  const rows = [
    { label: "January", value: 120 },
    { label: "February", value: 150 },
    { label: "March", value: 135 },
  ];

  try {
    for (const type of ["bar-chart", "line-chart"]) {
      const result = await t.engine.create({
        format: "png",
        spec: {
          procedural: {
            type,
            width: 512,
            height: 512,
            title: "Monthly performance",
            data: rows,
          },
        },
        name: `${type}-regression.png`,
      });

      assert.equal(result.success, true, `${type}: ${result.error}`);
      assert.equal(result.validation.passed, true, `${type}: validation failed`);

      const { buffer, meta } = await t.engine.read(result.artifactId);
      const dimensions = await sharp(buffer).metadata();

      assert.equal(dimensions.format, "png", `${type}: PNG format`);
      assert.equal(dimensions.width, 512, `${type}: width`);
      assert.equal(dimensions.height, 512, `${type}: height`);
      assert.ok(buffer.length > 1000, `${type}: non-trivial output`);
      assert.equal(meta.format, "png");
    }

    const mixedSvg = proceduralSvg({
      type: "bar-chart",
      width: 512,
      height: 512,
      title: "Positive and negative values",
      data: [
        { label: "Loss A", value: -20 },
        { label: "Loss B", value: -40 },
        { label: "Gain", value: 30 },
      ],
    });
    const barRects = [...mixedSvg.matchAll(
      /<rect x="[^"]+" y="[^"]+" width="[^"]+" height="([^"]+)" fill="[^"]+"\/>/g
    )];
    assert.equal(barRects.length, 3, "mixed chart should contain three bars");
    assert.ok(
      barRects.every((match) => Number(match[1]) > 0),
      `positive and negative bars must have visible heights: ${barRects.map((match) => match[1]).join(", ")}`,
    );

    const invalidRows = [
      [{ label: "Only", value: 1 }],
      Array.from({ length: 61 }, (_, i) => ({ label: `Row ${i}`, value: i })),
      [{ label: "", value: 1 }, { label: "B", value: 2 }],
      [{ label: "A", value: 1 }, { label: "B", value: Infinity }],
      [{ label: "A", value: 1e10 }, { label: "B", value: 2 }],
      [{ label: "A", value: "12" }, { label: "B", value: 2 }],
      [{ label: "A".repeat(81), value: 1 }, { label: "B", value: 2 }],
    ];

    for (const data of invalidRows) {
      assert.throws(
        () => proceduralSvg({ type: "bar-chart", data }),
        "invalid chart data must be rejected",
      );
    }
  } finally {
    await t.cleanup();
  }
});

test("security: unsafe zip paths and SVG rejected", async () => {
  assert.throws(() => validateEntryPath("../evil.txt"));
  assert.throws(() => validateEntryPath("/etc/passwd"));
  assert.throws(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  const t = await setup();
  try {
    const r = await t.engine.create({ format: "zip", spec: { files: [{ path: "../x", content: "y" }] } });
    assert.equal(r.success, false);
    assert.equal(r.code, "INVALID_INPUT");
    await assert.rejects(() => t.engine.read("../../etc/passwd"));
  } finally { await t.cleanup(); }
});

test("versioning, preview, conversion and confirm-gated delete", async () => {
  const t = await setup();
  try {
    const r = await t.engine.create({ format: "md", spec: { content: "# One\n\nfirst" }, name: "n.md" });
    const e = await t.engine.edit(r.artifactId, { spec: { content: "# One\n\nsecond" } });
    assert.equal(e.success, true, e.error);
    const d = await t.engine.describe(r.artifactId);
    assert.equal(d.versionList.length, 2);
    assert.match((await t.engine.read(r.artifactId, 1)).buffer.toString(), /first/);
    assert.match((await t.engine.read(r.artifactId)).buffer.toString(), /second/);
    const p = await t.engine.preview(r.artifactId);
    assert.equal(p.kind, "text");
    assert.match(p.text, /second/);
    const c = await t.engine.convert(r.artifactId, "html");
    assert.equal(c.success, true, c.error);
    if (hasOffice) {
      const pdf = await t.engine.convert(r.artifactId, "pdf");
      assert.equal(pdf.success, true, pdf.error);
    }
    await assert.rejects(() => t.engine.delete(r.artifactId, {}));
    await assert.rejects(() => t.engine.delete(r.artifactId, { confirm: "wrong" }));
    await t.engine.delete(r.artifactId, { confirm: r.artifactId });
    await assert.rejects(() => t.engine.describe(r.artifactId));
  } finally { await t.cleanup(); }
});

test("invalid input returns structured failures and leaves no temp files", async () => {
  const t = await setup();
  try {
    assert.equal((await t.engine.create({ format: "nope", spec: {} })).success, false);
    assert.equal((await t.engine.create({ format: "pdf", spec: null })).success, false);
    const noProvider = await t.engine.create({ prompt: "create a pdf about tea" });
    assert.equal(noProvider.success, false);
    assert.equal(noProvider.code, "PROVIDER_FAILURE");
    assert.equal(await tempCount(t.root), 0);
  } finally { await t.cleanup(); }
});

test("generation timeout is reported as TIMEOUT", async () => {
  const t = await setup({ extra: { generationTimeoutMs: 1 } });
  try {
    const r = await t.engine.create({ format: "pdf", spec: { content: DOC } });
    assert.equal(r.success, false);
    assert.equal(r.code, "TIMEOUT");
    assert.equal(await tempCount(t.root), 0);
  } finally { await t.cleanup(); }
});

test("prompt flow uses the provider; refusals are provider failures, not files", async () => {
  const providers = [{ id: "openrouter", key: "K", base: "http://x" }];
  const env = { K: "secret-key" };
  let reply = "# Tea\n\n## Brewing\n\nSteep for three minutes.";
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) });
  const router = createTextRouter({ getProviders: () => providers, env, fetchImpl });
  const t = await setup({ textRouter: router });
  try {
    const ok = await t.engine.create({ prompt: "create a pdf about tea" });
    assert.equal(ok.success, true, ok.error);
    assert.ok(!JSON.stringify(ok).includes("secret-key"));
    reply = "I'm sorry, I cannot create PDF files.";
    const bad = await t.engine.create({ prompt: "create a pdf about coffee" });
    assert.equal(bad.success, false);
    assert.ok(["PROVIDER_FAILURE", "GENERATION_FAILURE"].includes(bad.code));
  } finally { await t.cleanup(); }
});

test("provider router: free-tier order, cooldown, explicit override", async () => {
  const calls = [];
  let status = 429;
  const fetchImpl = async (url) => { calls.push(url); return status === 200 ? { ok: true, status, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } : { ok: false, status }; };
  const providers = [{ id: "gemini", key: "G", base: "http://g" }, { id: "openrouter", key: "O", base: "http://o" }];
  let clock = 0;
  const mk = (env) => createTextRouter({ getProviders: () => providers, env, fetchImpl, now: () => clock });
  const r1 = mk({ G: "g", O: "o" });
  assert.deepEqual(r1.eligible(), ["openrouter"], "gemini not used unless free tier enabled");
  const r2 = mk({ G: "g", O: "o", EXILE_GEMINI_FREE_TIER: "true" });
  assert.deepEqual(r2.eligible(), ["gemini", "openrouter"]);
  await assert.rejects(() => r1.generateText({ system: "s", prompt: "p" }), /No permitted provider/);
  const n = calls.length;
  await assert.rejects(() => r1.generateText({ system: "s", prompt: "p" }), /cooling down/);
  assert.equal(calls.length, n, "cooling provider is skipped");
  clock = 61_000; status = 200;
  assert.equal((await r1.generateText({ system: "s", prompt: "p" })).provider, "openrouter");
  await assert.rejects(() => mk({ O: "o" }).generateText({ system: "s", prompt: "p", provider: "nonexistent" }), /unavailable/);
});

test("delivery: sent only when the sender confirms; failures keep the artifact", async () => {
  let behaviour = "ok";
  const senders = { whatsapp: async () => { if (behaviour === "throw") throw new Error("WhatsApp is not connected"); return { sent: behaviour === "ok" }; } };
  const t = await setup({ senders });
  try {
    const r = await t.engine.create({ format: "pdf", spec: { content: DOC } });
    const sent = await t.engine.deliver(r.artifactId, { to: "1@s.whatsapp.net" });
    assert.equal(sent.state, "sent");
    behaviour = "unconfirmed";
    assert.equal((await t.engine.deliver(r.artifactId, { to: "x" })).state, "failed");
    behaviour = "throw";
    const failed = await t.engine.deliver(r.artifactId, { to: "x" });
    assert.equal(failed.success, false);
    assert.equal(failed.artifactRetained, true);
    const d = await t.engine.describe(r.artifactId);
    assert.deepEqual(d.deliveries.map((x) => x.state), ["sent", "failed", "failed"]);
    const md = await t.engine.create({ format: "md", spec: { content: "# a" } });
    const notSendable = await t.engine.deliver(md.artifactId, { to: "x" });
    assert.equal(notSendable.success, false);
    const noChannel = await t.engine.deliver(r.artifactId, { channel: "telegram", to: "x" });
    assert.equal(noChannel.code, "ENGINE_UNAVAILABLE");
  } finally { await t.cleanup(); }
});

test("missing engines are reported, not faked", async () => {
  if (!hasFfmpeg) return;
  const saved = { PATH: process.env.PATH, EXILE_FFMPEG: process.env.EXILE_FFMPEG };
  const t = await setup();
  try {
    process.env.PATH = "/nonexistent"; delete process.env.EXILE_FFMPEG;
    assert.equal(findTool("ffmpeg", { refresh: true }), null);
    const r = await t.engine.create({ format: "mp4", spec: { scenes: [{ narration: "Hello" }] } });
    assert.equal(r.success, false);
    assert.ok(["ENGINE_UNAVAILABLE", "GENERATION_FAILURE", "INVALID_INPUT"].includes(r.code));
    assert.equal(await tempCount(t.root), 0);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.EXILE_FFMPEG !== undefined) process.env.EXILE_FFMPEG = saved.EXILE_FFMPEG;
    findTool("ffmpeg", { refresh: true });
    await t.cleanup();
  }
});

test("audio and video with real ffmpeg", { skip: !hasFfmpeg }, async () => {
  const t = await setup();
  try {
    const wav = await t.engine.create({ format: "wav", spec: { tones: [{ freq: 440, durationMs: 300 }] } });
    assert.equal(wav.success, true, wav.error);
    const mp3 = await t.engine.convert(wav.artifactId, "mp3");
    assert.equal(mp3.success, true, mp3.error);
    const mp4 = await t.engine.create({ format: "mp4", spec: { scenes: [{ narration: "Hello world" }, { narration: "Second scene" }] } });
    assert.equal(mp4.success, true, mp4.error);
    assert.equal(await tempCount(t.root), 0);
  } finally { await t.cleanup(); }
});

test("intent detection: conversation is not a file request; frontend mirrors backend", () => {
  const corpus = [
    "create a pdf about tea", "make me an excel spreadsheet of expenses", "generate a powerpoint on solar energy",
    "write a csv of 10 users", "draw a chart of sales", "make a video explainer about rain", "send me a word document of the minutes",
    "how do I make a PDF?", "what is a CSV file", "tell me a story", "write an essay on justice", "hello there",
    "create a keynote deck", "make an mp3 narration of this text", "build a zip of the project",
  ];
  for (const text of corpus) {
    const a = detectArtifactRequest(text);
    const b = detectArtifactIntent(text);
    assert.equal(!!a, !!b, `presence mismatch for: ${text}`);
    if (a && b) assert.equal(!!a.unsupported, !!b.unsupported, text);
    if (a && b && !a.unsupported) assert.equal(a.format, b.format, text);
  }
  assert.equal(detectArtifactRequest("how do I make a PDF?"), null);
  assert.equal(detectArtifactRequest("create a keynote deck").unsupported, true);
});

async function serve(handler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!(await handler(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
const raw = (port, p, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});

test("HTTP API: access control, SSE progress, download headers, traversal, delete", async () => {
  const t = await setup();
  const api = createArtifactApiHandler({ engine: t.engine, getSecret: () => "s3cret" });
  const s = await serve(api);
  const auth = { "x-exile-local-auth": "s3cret" };
  try {
    assert.equal((await raw(s.port, "/artifacts/capabilities")).status, 401);
    assert.equal((await raw(s.port, "/artifacts/capabilities", { headers: { ...auth, origin: "https://evil.example" } })).status, 403);
    assert.equal((await raw(s.port, "/artifacts/capabilities", { headers: { ...auth, host: "evil.example" } })).status, 403);
    assert.equal((await raw(s.port, "/artifacts/capabilities", { headers: auth })).status, 200);

    const sse = await raw(s.port, "/artifacts", { method: "POST", headers: { ...auth, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ format: "pdf", spec: { content: DOC } }) });
    const events = parseSse(sse.body.toString()).events;
    assert.ok(events.some((e) => e.event === "progress"));
    assert.equal(parseSse(sse.body.toString()).rest, "");
    const result = events.find((e) => e.event === "result").data.result;
    assert.equal(result.success, true);
    const id = result.artifactId;

    const dl = await raw(s.port, `/artifacts/${id}/download`, { headers: auth });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers["content-type"], "application/pdf");
    assert.equal(dl.headers["x-content-type-options"], "nosniff");
    assert.match(dl.headers["content-security-policy"], /sandbox/);
    assert.equal(dl.body.subarray(0, 4).toString(), "%PDF");

    assert.equal((await raw(s.port, "/artifacts/..%2F..%2Fetc%2Fpasswd", { headers: auth })).status, 404);
    assert.equal((await raw(s.port, "/artifacts/art_000000000000000000000000", { headers: auth })).status, 404);
    assert.equal((await raw(s.port, `/artifacts/${id}`, { method: "DELETE", headers: auth })).status, 403);
    assert.equal((await raw(s.port, `/artifacts/${id}?confirm=${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await raw(s.port, `/artifacts/${id}`, { headers: auth })).status, 404);
    const leaked = (await raw(s.port, "/artifacts/audit", { headers: auth })).body.toString();
    assert.ok(!leaked.includes(t.root), "no absolute paths in responses");
  } finally { await s.close(); await t.cleanup(); }
});

test("frontend client talks to the real handler (SSE parsing, failures, download)", async () => {
  const t = await setup();
  const s = await serve(createArtifactApiHandler({ engine: t.engine, getSecret: () => "" }));
  try {
    const client = createArtifactClient({ getBase: async () => `http://127.0.0.1:${s.port}`, fetchImpl: fetch });
    const stages = [];
    const ok = await client.create({ format: "txt", spec: { content: "hello" } }, (p) => stages.push(p.stage));
    assert.equal(isFail(ok), false);
    assert.ok(stages.includes("validating"));
    const bad = await client.create({ format: "json", spec: { content: "{oops" } }, () => {});
    assert.equal(isFail(bad), true);
    assert.ok(bad.error);
  } finally { await s.close(); await t.cleanup(); }
});

test("parseSse handles chunk-split and multiple events", () => {
  const whole = 'event: progress\ndata: {"a":1}\n\nevent: result\ndata: {"ok":true}\n\n';
  const { events: evs } = parseSse(whole);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].data.ok, true);
  const cut = parseSse(whole.slice(0, 30));
  assert.equal(cut.events.length, 0);
  assert.equal(parseSse(cut.rest + whole.slice(30)).events.length, 2);
});
