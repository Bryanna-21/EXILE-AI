import test from "node:test";
import assert from "node:assert/strict";
import { parseMessage, parseFenceInfo, splitLinks } from "../src/lib/chat/parse.ts";
import { languageInfo } from "../src/lib/chat/languages.ts";
import * as F from "../src/lib/chat/files.ts";
import * as O from "../src/lib/chat/ops.ts";
import { highlightCode, canHighlight } from "../src/lib/chat/highlight.ts";
import { ChatMediaStore } from "../src/lib/chat/mediaStore.ts";

const turn = (id, role, text, extra = {}) => ({ id, role, text, at: Date.now(), ...extra });

test("parse: text and code, indentation preserved", () => {
  const p = parseMessage("Intro\n```python main.py\ndef f():\n    return 1\n```\nDone");
  assert.equal(p.length, 3);
  assert.equal(p[1].type, "code");
  assert.equal(p[1].language, "python");
  assert.equal(p[1].filename, "main.py");
  assert.equal(p[1].code, "def f():\n    return 1");
  assert.equal(p[1].complete, true);
});
test("parse: unterminated fence while streaming", () => {
  const p = parseMessage("x\n```js\nconst a = 1;");
  assert.equal(p[1].complete, false);
  assert.equal(p[1].code, "const a = 1;");
});
test("parse: CRLF and fence info variants", () => {
  assert.equal(parseMessage("```ts\r\nlet a\r\n```")[0].code, "let a");
  assert.equal(parseFenceInfo("tsx src/App.tsx").filename, "App.tsx"); // directories are dropped so the name is a safe download name
  assert.equal(parseFenceInfo("python:main.py").filename, "main.py");
});
test("parse: links are http(s) only", () => {
  const parts = splitLinks("see https://a.com/x and javascript:alert(1)");
  assert.ok(parts.some((p) => p.type === "link" && p.href === "https://a.com/x"));
  assert.ok(!parts.some((p) => p.type === "link" && /javascript/.test(p.href)));
});

test("languages", () => {
  assert.equal(languageInfo("ts").id, "typescript");
  assert.equal(languageInfo("py").ext, "py");
  assert.equal(languageInfo("", "#!/bin/bash\nls").id, "bash");
  assert.equal(languageInfo("brainfuck").label, "brainfuck");
});

test("files: size, extension, kind, safe names, labels", () => {
  assert.equal(F.formatBytes(0), "0 B");
  assert.equal(F.formatBytes(1536), "1.5 KB");
  assert.equal(F.formatBytes(5 * 1024 ** 2), "5.0 MB");
  assert.equal(F.fileExtension("a/b/Report.Final.PDF"), "pdf");
  assert.equal(F.fileExtension(".env"), "");
  assert.equal(F.classifyFile("x.png"), "image");
  assert.equal(F.classifyFile("x.ts"), "code");
  assert.equal(F.classifyFile("x.csv"), "data");
  assert.equal(F.classifyFile("x.docx"), "document");
  assert.equal(F.safeFilename("../../etc/pa:ss*wd?.txt"), "passwd.txt");
  assert.equal(F.safeFilename("   "), "download");
  const { text, names } = F.stripAttachmentLabel(F.withAttachmentLabel("hi", ["a.pdf", "b.png"]));
  assert.equal(text, "hi");
  assert.deepEqual(names, ["a.pdf", "b.png"]);
  assert.equal(F.dataUrlBytes("data:text/plain;base64,aGVsbG8="), 5);
  assert.equal(F.dataUrlMime("data:image/png;base64,AA=="), "image/png");
});

test("ops: delivery status", () => {
  const t = [turn("1", "user", "q"), turn("2", "exile", "a")];
  assert.equal(O.deliveryStatus(t, 0, false), "answered");
  assert.equal(O.deliveryStatus([turn("1", "user", "q")], 0, true), "sending");
  assert.equal(O.deliveryStatus([turn("1", "user", "q"), turn("2", "exile", "…")], 0, true), "sending");
  assert.equal(O.deliveryStatus([turn("1", "user", "q"), turn("2", "exile", "…")], 0, false), "sent");
  assert.equal(O.deliveryStatus([turn("1", "user", "q"), turn("2", "exile", "par")], 0, true), "sent");
  assert.equal(O.deliveryStatus([turn("1", "user", "a"), turn("2", "exile", "b"), turn("3", "user", "c"), turn("4", "exile", "…")], 0, true), "answered");
  assert.equal(O.deliveryStatus([turn("1", "user", "q"), turn("2", "exile", "a", { fallback: true })], 0, false), "answered-local");
  assert.equal(O.isStreamingTurn(t, 1, true), true);
  assert.equal(O.isStreamingTurn(t, 1, false), false);
});
test("ops: quotes and reply context", () => {
  assert.equal(O.buildQuote("a\n\n```js\nx\n```\nb"), "a [code] b");
  assert.equal(O.buildQuote("x".repeat(300), 20).length, 20);
  assert.equal(O.buildQuote("hi\n\n[Attached files: a.png]"), "hi");
  const t = [turn("1", "exile", "Earlier"), turn("2", "user", "why?", { replyTo: "1" })];
  assert.match(O.withReplyContext(t[1], t), /replying to your earlier message: "Earlier"/);
  assert.equal(O.withReplyContext(t[0], t), "Earlier");
  assert.equal(O.previousUserTurn(t, "1"), null);
  assert.equal(O.turnsAfter(t, "1").length, 1);
});
test("ops: day groups", () => {
  const now = new Date(2026, 10, 9, 12);
  const mk = (d, id) => turn(id, "user", "x", { at: d.getTime() });
  const g = O.dayGroups([mk(new Date(2026, 10, 8, 9), "a"), mk(new Date(2026, 10, 9, 8), "b"), mk(new Date(2026, 10, 9, 9), "c")], now, "en-US");
  assert.deepEqual(g.map((x) => [x.label, x.startIndex]), [["Yesterday", 0], ["Today", 1]]);
});

test("highlight: tokens for supported, plain for others, lossless", () => {
  const code = 'const a = "x"; // hi\nfunction f(){ return 1 }';
  const segs = highlightCode(code, "javascript");
  assert.equal(segs.map((s) => s.text).join(""), code);
  assert.ok(segs.some((s) => s.cls.includes("tok-keyword")));
  assert.ok(canHighlight("python"));
  assert.deepEqual(highlightCode("ls -la", "bash"), [{ text: "ls -la", cls: "" }]);
  const py = "def f():\n    return 1\n";
  assert.equal(highlightCode(py, "python").map((s) => s.text).join(""), py);
});

test("mediaStore: snapshot identity changes, subscribe, delete", () => {
  const s = new ChatMediaStore();
  let n = 0;
  const off = s.subscribe(() => n++);
  const before = s.getSnapshot();
  s.append("t1", { id: "f", name: "a.txt", mime: "text/plain", size: 1, kind: "text", origin: "attached" });
  assert.notEqual(s.getSnapshot(), before);
  assert.equal(s.getSnapshot().get("t1").length, 1);
  s.delete("t1");
  assert.equal(s.get("t1").length, 0);
  assert.equal(n, 2);
  off();
  s.set("t2", []);
  assert.equal(n, 2);
});
