import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamChatWithProviders } from "../local/chat-stream.mjs";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  headers = {};
  output = "";

  writeHead(_status, headers = {}) {
    this.headersSent = true;
    this.headers = headers;
  }

  write(chunk) {
    this.output += chunk;
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

const providers = [
  { id: "first", base: "https://first.test", key: "one", model: "test" },
  { id: "second", base: "https://second.test", key: "two", model: "test" },
];

const streamResponse = (content = "data: hello\n\n") => ({
  ok: true,
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(content));
      controller.close();
    },
  }),
});

test("chat stream: first-token timeout moves to the next provider", async () => {
  const res = new FakeResponse();
  const failed = [];
  const succeeded = [];

  const result = await streamChatWithProviders({
    body: {},
    messages: [],
    res,
    providers,
    timeoutMs: 20,
    markFailure: (provider) => failed.push(provider.id),
    markSuccess: (provider) => succeeded.push(provider.id),
    fetchImpl: async (url, options) => {
      if (url.includes("first.test")) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true }
          );
        });
      }
      return streamResponse();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(failed, ["first"]);
  assert.deepEqual(succeeded, ["second"]);
  assert.match(res.output, /data: hello/);
  assert.equal(res.writableEnded, true);
});

test("chat stream: client disconnect aborts upstream without fallback", async () => {
  const res = new FakeResponse();
  let aborted = false;
  const failed = [];

  const pending = streamChatWithProviders({
    body: {},
    messages: [],
    res,
    providers,
    timeoutMs: 1000,
    markFailure: (provider) => failed.push(provider.id),
    markSuccess: () => {},
    fetchImpl: async (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal.reason);
        }, { once: true });
      }),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  res.destroyed = true;
  res.emit("close");

  const result = await pending;

  assert.equal(result.aborted, true);
  assert.equal(aborted, true);
  assert.deepEqual(failed, []);
});

test("chat stream: successful stream completes without retry", async () => {
  const res = new FakeResponse();
  const attempted = [];
  const succeeded = [];

  const result = await streamChatWithProviders({
    body: {},
    messages: [],
    res,
    providers,
    corsHeaders: { "Access-Control-Allow-Origin": "http://localhost:5173" },
    markFailure: () => {},
    markSuccess: (provider) => succeeded.push(provider.id),
    fetchImpl: async (url) => {
      attempted.push(url);
      return streamResponse("data: completed\n\n");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempted.length, 1);
  assert.deepEqual(succeeded, ["first"]);
  assert.match(res.output, /data: completed/);
  assert.equal(
    res.headers["Access-Control-Allow-Origin"],
    "http://localhost:5173"
  );
  assert.equal(res.writableEnded, true);
});


test("chat stream: interruption after first chunk does not cool down provider", async () => {
  const res = new FakeResponse();
  const failed = [];
  const succeeded = [];
  let delivered = false;

  const result = await streamChatWithProviders({
    body: {},
    messages: [],
    res,
    providers,
    markFailure: (provider) => failed.push(provider.id),
    markSuccess: (provider) => succeeded.push(provider.id),
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream(
        {
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(Buffer.from("data: first chunk\n\n"));
            } else {
              controller.error(new Error("Upstream stream interrupted"));
            }
          },
        },
        { highWaterMark: 0 }
      ),
    }),
  });

  assert.equal(result.interrupted, true);
  assert.deepEqual(failed, []);
  assert.deepEqual(succeeded, ["first"]);
  assert.match(res.output, /data: first chunk/);
  assert.equal(res.headersSent, true);
  assert.equal(res.writableEnded, true);
});
