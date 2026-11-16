import test from "node:test";
import assert from "node:assert/strict";
import { createFreeProviderPool } from "../local/provider-pool.mjs";
import { createWhatsAppProviderRouter } from "../local/whatsapp-provider-router.mjs";

function setup(env, { clock = () => 1_000 } = {}) {
  const pool = createFreeProviderPool({ clock });
  const providerRegistry = [
    {
      id: "openai",
      key: "OPENAI_API_KEY",
      base: "https://api.openai.com/v1",
      chat: "gpt-4.1",
    },
  ];

  const router = createWhatsAppProviderRouter({
    pool,
    providers: providerRegistry,
    env,
  });

  return { pool, router };
}

test("default WhatsApp routing rotates across configured free credentials only", () => {
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
    OPENROUTER_API_KEY: "o1",
    OPENAI_API_KEY: "paid",
  };
  const { router } = setup(env);

  const first = router.getProviders();
  const second = router.getProviders();

  assert.deepEqual(
    first.map((item) => item.keyName),
    ["GROQ_API_KEY", "GROQ_2_API_KEY", "OPENROUTER_API_KEY"]
  );
  assert.deepEqual(
    second.map((item) => item.keyName),
    ["GROQ_2_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY"]
  );
  assert.ok(first.every((item) => item.id !== "openai"));
});

test("explicit free-provider selection rotates only that provider's keys", () => {
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
    OPENROUTER_API_KEY: "o1",
  };
  const { router } = setup(env);

  assert.deepEqual(
    router.getProviders("groq").map((item) => item.keyName),
    ["GROQ_API_KEY", "GROQ_2_API_KEY"]
  );
  assert.deepEqual(
    router.getProviders("groq").map((item) => item.keyName),
    ["GROQ_2_API_KEY", "GROQ_API_KEY"]
  );
});

test("Gemini media routing includes all Gemini keys without automatic-chat opt-in", () => {
  const env = {
    GEMINI_API_KEY: "m1",
    GEMINI_2_API_KEY: "m2",
    GROQ_API_KEY: "g1",
    OPENROUTER_API_KEY: "o1",
  };
  const { router } = setup(env);

  assert.deepEqual(router.getProviders().map((item) => item.id), [
    "groq",
    "openrouter",
  ]);
  assert.deepEqual(
    router.getProviders("", { media: true }).map((item) => item.keyName),
    ["GEMINI_API_KEY", "GEMINI_2_API_KEY"]
  );
});

test("default WhatsApp routing includes Gemini only with explicit free-tier opt-in", () => {
  const { router } = setup({
    GROQ_API_KEY: "g1",
    GEMINI_API_KEY: "m1",
    EXILE_GEMINI_FREE_TIER: "true",
  });

  assert.deepEqual(
    router.getProviders().map((item) => item.id),
    ["groq", "gemini"]
  );
});

test("explicit paid-provider selection returns only its canonical credential", () => {
  const env = {
    OPENAI_API_KEY: "paid",
    OPENAI_2_API_KEY: "paid-numbered",
    GROQ_API_KEY: "free",
  };
  const { router } = setup(env);

  const selected = router.getProviders("openai");

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "openai");
  assert.equal(selected[0].keyName, "OPENAI_API_KEY");
  assert.equal(selected[0].key, "paid");
});

test("unknown or unconfigured explicit providers do not fall back", () => {
  const { router } = setup({
    GROQ_API_KEY: "free",
  });

  assert.deepEqual(router.getProviders("unknown-provider"), []);
  assert.deepEqual(router.getProviders("openai"), []);
});

test("free credential failures cool down that credential", () => {
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
  };
  const { router } = setup(env);

  const [first] = router.getProviders("groq");
  router.markFailure(first, 429);

  assert.deepEqual(
    router.getProviders("groq").map((item) => item.keyName),
    ["GROQ_2_API_KEY"]
  );
});

test("paid-provider failures do not enter the free-provider cooldown pool", () => {
  const env = {
    OPENAI_API_KEY: "paid",
    GROQ_API_KEY: "free",
  };
  const { router } = setup(env);

  const [paid] = router.getProviders("openai");
  router.markFailure(paid, 429);

  assert.deepEqual(
    router.getProviders().map((item) => item.keyName),
    ["GROQ_API_KEY"]
  );
});

test("successful free credentials are released from cooldown", () => {
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
  };
  const { router } = setup(env);

  const [first] = router.getProviders("groq");
  router.markFailure(first, 429);
  router.markSuccess(first);

  assert.equal(router.getProviders("groq").length, 2);
});
