import test from "node:test";
import assert from "node:assert/strict";
import { readStreamAbortable, abortableSleep } from "../src/lib/streamAbort.ts";

const enc = new TextEncoder();
function fakeReader(chunks, { hangAfter = false } = {}) {
  let i = 0, cancelled = false;
  return {
    get cancelled() { return cancelled; },
    read: () => (i < chunks.length ? Promise.resolve({ done: false, value: enc.encode(chunks[i++]) }) : hangAfter ? new Promise(() => {}) : Promise.resolve({ done: true })),
    cancel: async () => { cancelled = true; },
  };
}

test("reads all chunks when not aborted", async () => {
  const got = [];
  await readStreamAbortable(fakeReader(["a", "b", "c"]), undefined, (v) => got.push(new TextDecoder().decode(v)));
  assert.deepEqual(got, ["a", "b", "c"]);
});

test("abort during a stalled read stops immediately and cancels the underlying stream", async () => {
  const ac = new AbortController();
  const reader = fakeReader(["a"], { hangAfter: true });
  const got = [];
  const p = readStreamAbortable(reader, ac.signal, (v) => got.push(v));
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.equal(reader.cancelled, true);
  assert.equal(got.length, 1);
});

test("an already-aborted signal reads nothing", async () => {
  const ac = new AbortController(); ac.abort();
  const reader = fakeReader(["a", "b"]);
  const got = [];
  await assert.rejects(readStreamAbortable(reader, ac.signal, (v) => got.push(v)), (e) => e.name === "AbortError");
  assert.equal(reader.cancelled, true);
});

test("retry back-off is interrupted by abort", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = abortableSleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.ok(Date.now() - t0 < 1000);
  await abortableSleep(5);
});
