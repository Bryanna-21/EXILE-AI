import test from "node:test";
import assert from "node:assert/strict";
import { sniffKind, validateAttachment } from "../src/lib/chat/validate.ts";

const b = (...xs) => Uint8Array.from(xs);
const pad = (arr, n = 16) => Uint8Array.from([...arr, ...new Array(Math.max(0, n - arr.length)).fill(0x20)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = pad([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%....");
const EXE = pad([0x4d, 0x5a, 0x90, 0x00, 0x03]); // "MZ" + NUL: a Windows executable header
const txt = (s) => new TextEncoder().encode(s);

test("sniffKind recognises real signatures", () => {
  assert.equal(sniffKind(PNG), "png");
  assert.equal(sniffKind(JPG), "jpeg");
  assert.equal(sniffKind(WEBP), "webp");
  assert.equal(sniffKind(PDF), "pdf");
  assert.equal(sniffKind(txt("hello\nworld\ttab")), "text");
  assert.equal(sniffKind(txt("héllo — ünïcode ✓")), "text");
  assert.equal(sniffKind(b()), "empty");
  assert.equal(sniffKind(EXE), "binary");
});

const check = (name, expected, head, size = head.length) => validateAttachment({ name, expected, head, size });

test("a renamed executable is rejected as an image, PDF and text file", () => {
  assert.equal(check("evil.png", "image", EXE).ok, false);
  assert.equal(check("evil.pdf", "pdf", EXE).ok, false);
  assert.equal(check("evil.txt", "text", EXE).ok, false);
});

test("a text file named .png and a PNG named .pdf are rejected", () => {
  assert.match(check("fake.png", "image", txt("just text")).error, /not a real/);
  assert.match(check("fake.pdf", "pdf", PNG).error, /not a valid PDF/);
});

test("real files pass", () => {
  assert.equal(check("a.png", "image", PNG).ok, true);
  assert.equal(check("a.jpg", "image", JPG).ok, true);
  assert.equal(check("a.webp", "image", WEBP).ok, true);
  assert.equal(check("a.pdf", "pdf", PDF).ok, true);
  assert.equal(check("a.py", "text", txt("print('hi')\n")).ok, true);
});

test("GIF is not accepted as an image attachment (not in the supported set)", () => {
  assert.equal(check("a.gif", "image", pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])).ok, false);
});

test("empty files are rejected with a clear message", () => {
  assert.match(check("empty.txt", "text", b(), 0).error, /empty/);
});
