import test from "node:test";
import assert from "node:assert/strict";
import { createImageRouter } from "../local/artifacts/image-provider-router.mjs";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";

const models = [
  {
    name: "community/scriptsnsenses-sys/lucid-origin:free",
    title: "Lucid Origin (FREE ; CONTRIBUTOR)",
    paid_only: false,
    input_modalities: ["text"],
    output_modalities: ["image"],
    pricing: { currency: "pollen" },
  },
  {
    name: "community/scriptsnsenses-sys/flux-2-dev-free",
    title: "Flux 2 Dev (FREE ; CONTRIBUTOR)",
    paid_only: false,
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    pricing: { currency: "pollen" },
  },
  {
    name: "tongyi-mai/z-image-turbo",
    title: "Z-Image Turbo",
    paid_only: false,
    input_modalities: ["text"],
    output_modalities: ["image"],
    pricing: { currency: "pollen", completionImageTokens: "0.004" },
  },
  {
    name: "openai/example-paid",
    title: "Example Paid Image Model",
    paid_only: true,
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    pricing: { image: 0.02 },
  },
  {
    name: "community/ambiguous-model",
    title: "Community Model",
    paid_only: false,
    input_modalities: ["text"],
    output_modalities: ["image"],
    pricing: { currency: "pollen" },
  },
];

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return { fetchImpl, calls };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createRouter(handler = () => jsonResponse(models)) {
  const mock = mockFetch((url, options, count) => {
    if (url.endsWith("/image/models")) return jsonResponse(models);
    return handler(url, options, count);
  });
  return {
    ...mock,
    router: createImageRouter({
      env: { POLLINATIONS_API_KEY: "sk_test_key" },
      fetchImpl: mock.fetchImpl,
    }),
  };
}

test("normalizes the live catalogue name/title schema and marks only verified free contributors", async () => {
  const { router } = createRouter();
  const result = await router.listModels();

  assert.equal(result.length, 5);
  assert.equal(result[0].id, "community/scriptsnsenses-sys/lucid-origin:free");
  assert.equal(result[0].name, "Lucid Origin (FREE ; CONTRIBUTOR)");
  assert.equal(result[0].free, true);
  assert.equal(result[1].free, true);
  assert.equal(result[2].free, false);
  assert.equal(result[3].free, false);
  assert.equal(result[4].free, false);
});

test("discovers and caches the live model catalogue", async () => {
  let count = 0;
  const { fetchImpl } = mockFetch(() => {
    count++;
    return jsonResponse(models);
  });

  const router = createImageRouter({ fetchImpl, now: () => 1000 });
  const first = await router.listModels();
  const second = await router.listModels();

  assert.equal(first.length, 5);
  assert.deepEqual(second, first);
  assert.equal(count, 1);
});

test("refreshes the model catalogue when requested", async () => {
  let count = 0;
  const { fetchImpl } = mockFetch(() => {
    count++;
    return jsonResponse(models);
  });

  const router = createImageRouter({ fetchImpl });
  await router.listModels();
  await router.listModels({ refresh: true });

  assert.equal(count, 2);
});

test("defaults to a verified free model, never the first paid or unverified model", async () => {
  const { router, calls } = createRouter((url) =>
    jsonResponse({ data: [{ b64_json: pngBase64 }] }),
  );

  const result = await router.generate({ prompt: "A mountain landscape" });

  assert.equal(result.model, "community/scriptsnsenses-sys/lucid-origin:free");
  assert.equal(result.provider, "pollinations");
  assert.equal(result.edited, false);
  assert.ok(Buffer.isBuffer(result.buffer));

  const request = calls.find((call) => call.url.endsWith("/v1/images/generations"));
  assert.ok(request);
  assert.equal(request.options.headers.Authorization, "Bearer sk_test_key");
  assert.equal(JSON.parse(request.options.body).model, result.model);
});

test("allows an explicitly selected verified free contributor model", async () => {
  const { router, calls } = createRouter((url) =>
    jsonResponse({ data: [{ b64_json: pngBase64 }] }),
  );

  const result = await router.generate({
    prompt: "A landscape",
    model: "community/scriptsnsenses-sys/flux-2-dev-free",
  });

  assert.equal(result.model, "community/scriptsnsenses-sys/flux-2-dev-free");
  const request = calls.find((call) => call.url.endsWith("/v1/images/generations"));
  assert.equal(JSON.parse(request.options.body).model, result.model);
});

test("blocks explicitly selected priced models", async () => {
  const { router, calls } = createRouter();

  await assert.rejects(
    router.generate({
      prompt: "A landscape",
      model: "tongyi-mai/z-image-turbo",
    }),
    /not verified as free/,
  );

  assert.equal(calls.some((call) => call.url.includes("/v1/images/")), false);
});

test("blocks paid-only models even if their title claims FREE", async () => {
  const misleading = models.map((model) =>
    model.name === "openai/example-paid"
      ? { ...model, title: "Example FREE Model" }
      : model,
  );

  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/image/models")
      ? jsonResponse(misleading)
      : jsonResponse({ data: [{ b64_json: pngBase64 }] }),
  );

  const router = createImageRouter({
    env: { POLLINATIONS_API_KEY: "sk_test_key" },
    fetchImpl,
  });

  await assert.rejects(
    router.generate({ prompt: "A landscape", model: "openai/example-paid" }),
    /not verified as free/,
  );
  assert.equal(calls.some((call) => call.url.includes("/v1/images/")), false);
});

test("requires image input for reference-image editing and selects a free editor", async () => {
  const { router, calls } = createRouter((url) =>
    jsonResponse({ data: [{ b64_json: pngBase64 }] }),
  );

  const reference = `data:image/png;base64,${pngBase64}`;
  const result = await router.generate({
    prompt: "Make the building taller",
    referenceImage: reference,
  });

  assert.equal(result.model, "community/scriptsnsenses-sys/flux-2-dev-free");
  assert.equal(result.edited, true);

  const request = calls.find((call) => call.url.endsWith("/v1/images/edits"));
  assert.ok(request);
  const body = JSON.parse(request.options.body);
  assert.equal(body.image, reference);
  assert.equal(body.model, result.model);
});

test("rejects a free generation model that does not support image input for editing", async () => {
  const { router } = createRouter();

  await assert.rejects(
    router.generate({
      prompt: "Edit this",
      model: "community/scriptsnsenses-sys/lucid-origin:free",
      referenceImage: `data:image/png;base64,${pngBase64}`,
    }),
    /does not support reference-image editing/,
  );
});

test("fails closed when no verified free models remain", async () => {
  const { fetchImpl, calls } = mockFetch((url) => {
    if (url.endsWith("/image/models")) {
      return jsonResponse(models.map((model) => ({ ...model, paid_only: true })));
    }
    return jsonResponse({ data: [{ b64_json: pngBase64 }] });
  });

  const router = createImageRouter({
    env: { POLLINATIONS_API_KEY: "sk_test_key" },
    fetchImpl,
  });

  await assert.rejects(
    router.generate({ prompt: "A landscape" }),
    /No verified provider-labelled free contributor/,
  );
  assert.equal(calls.some((call) => call.url.includes("/v1/images/")), false);
});

test("rejects missing or invalid API keys without making requests", async () => {
  let calls = 0;
  const router = createImageRouter({
    env: { POLLINATIONS_API_KEY: "pk_not_a_secret_key" },
    fetchImpl: async () => {
      calls++;
      return jsonResponse(models);
    },
  });

  await assert.rejects(
    router.generate({ prompt: "A landscape" }),
    /Configure a Pollinations API key/,
  );
  assert.equal(calls, 0);
});

test("rejects invalid reference images", async () => {
  const { router } = createRouter();

  await assert.rejects(
    router.generate({
      prompt: "Edit this",
      referenceImage: "https://example.com/image.png",
    }),
    /must be a PNG, JPEG or WebP data URL/,
  );
});

test("rejects models not present in the live catalogue", async () => {
  const { router } = createRouter();

  await assert.rejects(
    router.generate({ prompt: "A landscape", model: "obsolete-model" }),
    /not in the current free Pollinations catalogue/,
  );
});

test("reports provider HTTP errors without exposing credentials", async () => {
  const { router } = createRouter(() =>
    jsonResponse({ error: { message: "Insufficient balance" } }, 402),
  );

  await assert.rejects(
    router.generate({ prompt: "A landscape" }),
    (error) => {
      assert.match(error.message, /402/);
      assert.match(error.message, /Insufficient balance/);
      assert.doesNotMatch(error.message, /sk_test_key/);
      return true;
    },
  );
});
