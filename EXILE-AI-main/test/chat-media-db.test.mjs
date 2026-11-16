import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryBackend, planEviction, recordBytes, MAX_SCOPE_BYTES } from "../src/lib/chat/mediaDb.ts";

const file = (id, bytes) => ({ id, name: id + ".bin", mime: "application/octet-stream", size: bytes, kind: "file", file: new Blob([new Uint8Array(bytes)]), origin: "attached" });

test("planEviction: nothing evicted when it fits; oldest first when it does not; too-large is rejected", () => {
  const rows = [{ id: "a", at: 1, bytes: 40 }, { id: "b", at: 2, bytes: 40 }, { id: "c", at: 3, bytes: 20 }];
  assert.deepEqual(planEviction(rows, { id: "n", bytes: 0 }, 100), []);
  assert.deepEqual(planEviction(rows, { id: "n", bytes: 30 }, 100), ["a"]);
  assert.deepEqual(planEviction(rows, { id: "n", bytes: 70 }, 100), ["a", "b"]);
  assert.equal(planEviction(rows, { id: "n", bytes: 101 }, 100), null);
  assert.deepEqual(planEviction(rows, { id: "a", bytes: 50 }, 100), ["b"], "replacing an id does not count its old copy");
  assert.ok(MAX_SCOPE_BYTES > 0);
});

test("memory backend: put/get/delete round trip keeps the original blob and metadata", async () => {
  const b = createMemoryBackend();
  await b.put("s", "m1", [file("f1", 10)]);
  const [rec] = await b.getMany("s", ["m1", "missing"]);
  assert.equal(rec.files[0].name, "f1.bin");
  assert.equal(rec.files[0].file.size, 10);
  await b.delete("s", ["m1"]);
  assert.deepEqual(await b.getMany("s", ["m1"]), []);
});

test("scopes are isolated from each other", async () => {
  const b = createMemoryBackend();
  await b.put("alice", "m1", [file("f", 5)]);
  assert.equal((await b.getMany("bob", ["m1"])).length, 0);
  await b.put("bob", "m1", [file("g", 7)]);
  await b.clearScope("alice");
  assert.equal((await b.getMany("alice", ["m1"])).length, 0);
  assert.equal((await b.getMany("bob", ["m1"])).length, 1);
});

test("quota: old records are evicted to make room; an oversized file is refused and nothing else is lost", async () => {
  const b = createMemoryBackend(100);
  await b.put("s", "old", [file("o", 60)], 1);
  await b.put("s", "mid", [file("m", 30)], 2);
  const r = await b.put("s", "new", [file("n", 40)], 3);
  assert.deepEqual(r, { stored: true, evicted: ["old"] });
  const big = await b.put("s", "huge", [file("h", 500)], 4);
  assert.equal(big.stored, false);
  assert.equal(big.reason, "too-large");
  assert.equal((await b.getMany("s", ["mid", "new"])).length, 2);
});

test("recordBytes counts blob, data URL and text", () => {
  assert.equal(recordBytes([{ ...file("x", 10), dataUrl: "abcd", text: "hi" }]), 10 + 4 + 4);
});
