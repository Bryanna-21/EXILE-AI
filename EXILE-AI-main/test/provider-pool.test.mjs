import test from "node:test";
import assert from "node:assert/strict";
import { createFreeProviderPool } from "../local/provider-pool.mjs";

test("free pool includes only explicitly supported free-tier providers", () => {
  const pool = createFreeProviderPool();
  const keys = pool.credentials({
    GROQ_API_KEY: "g1",
    OPENROUTER_API_KEY: "o1",
    GEMINI_API_KEY: "m1",
    OPENAI_API_KEY: "paid",
    DEEPSEEK_API_KEY: "paid",
  });

  assert.deepEqual(keys.map((item) => item.id), ["groq", "openrouter"]);
  assert.ok(keys.every((item) => item.id !== "openai" && item.id !== "deepseek"));
});

test("Gemini is included only after explicit free-tier opt-in", () => {
  const pool = createFreeProviderPool();

  assert.equal(
    pool.credentials({ GEMINI_API_KEY: "g" }).length,
    0
  );

  assert.equal(
    pool.credentials({
      GEMINI_API_KEY: "g",
      EXILE_GEMINI_FREE_TIER: "true",
    })[0].id,
    "gemini"
  );
});

test("numbered credentials are discovered and ordered numerically", () => {
  const pool = createFreeProviderPool();
  const keys = pool.credentials({
    GROQ_3_API_KEY: "third",
    GROQ_API_KEY: "first",
    GROQ_2_API_KEY: "second",
    GROQ_API_KEY_4: "unsupported",
  });

  assert.deepEqual(
    keys.map((item) => [item.keyName, item.key]),
    [
      ["GROQ_API_KEY", "first"],
      ["GROQ_2_API_KEY", "second"],
      ["GROQ_3_API_KEY", "third"],
    ]
  );
});

test("successive requests rotate their starting credential", () => {
  const pool = createFreeProviderPool();
  const env = {
    GROQ_API_KEY: "g",
    OPENROUTER_API_KEY: "o",
  };

  assert.deepEqual(pool.next(env).map((item) => item.keyName), [
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
  assert.deepEqual(pool.next(env).map((item) => item.keyName), [
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
  ]);
});

test("EXILE_PRIMARY_PROVIDER determines the initial rotation position", () => {
  const pool = createFreeProviderPool();
  const env = {
    GROQ_API_KEY: "g",
    OPENROUTER_API_KEY: "o",
    EXILE_PRIMARY_PROVIDER: "openrouter",
  };

  assert.equal(pool.next(env)[0].id, "openrouter");
  assert.equal(pool.next(env)[0].id, "groq");
});

test("rate-limited credentials are cooled down while other keys remain eligible", () => {
  let now = 1_000;
  const pool = createFreeProviderPool({ clock: () => now });
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
    OPENROUTER_API_KEY: "o",
  };

  const first = pool.credentials(env)[0];
  pool.markFailure(first, 429);

  assert.deepEqual(
    pool.next(env).map((item) => item.keyName),
    ["GROQ_2_API_KEY", "OPENROUTER_API_KEY"]
  );

  now += 61_000;
  assert.equal(pool.next(env).length, 3);
});

test("invalid credentials receive a longer cooldown than transient failures", () => {
  let now = 10_000;
  const pool = createFreeProviderPool({ clock: () => now });
  const env = {
    GROQ_API_KEY: "g",
    OPENROUTER_API_KEY: "o",
  };
  const [groq, openrouter] = pool.credentials(env);

  pool.markFailure(groq, 401);
  pool.markFailure(openrouter, 503);

  now += 20_000;
  assert.deepEqual(pool.next(env).map((item) => item.keyName), [
    "OPENROUTER_API_KEY",
  ]);
});

test("provider pool never returns credentials for paid-only providers", () => {
  const pool = createFreeProviderPool();
  const keys = pool.next({
    OPENAI_API_KEY: "paid",
    TOGETHER_API_KEY: "paid",
    DEEPSEEK_API_KEY: "paid",
    MISTRAL_API_KEY: "paid",
    XAI_API_KEY: "paid",
    PERPLEXITY_API_KEY: "paid",
    LOVABLE_API_KEY: "paid",
  });

  assert.deepEqual(keys, []);
});

test("provider-specific rotation does not advance global rotation", () => {
  const pool = createFreeProviderPool();
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
    OPENROUTER_API_KEY: "o1",
  };

  assert.deepEqual(
    pool.nextFor("groq", env).map((item) => item.keyName),
    ["GROQ_API_KEY", "GROQ_2_API_KEY"]
  );

  assert.deepEqual(
    pool.nextFor("groq", env).map((item) => item.keyName),
    ["GROQ_2_API_KEY", "GROQ_API_KEY"]
  );

  assert.equal(pool.next(env)[0].keyName, "GROQ_API_KEY");
});

test("provider-specific rotation respects credential cooldowns", () => {
  const pool = createFreeProviderPool({ clock: () => 1000 });
  const env = {
    GROQ_API_KEY: "g1",
    GROQ_2_API_KEY: "g2",
  };

  const [first] = pool.credentialsFor("groq", env);
  pool.markFailure(first, 429);

  assert.deepEqual(
    pool.nextFor("groq", env).map((item) => item.keyName),
    ["GROQ_2_API_KEY"]
  );
});

test("Gemini media credentials include numbered keys without enabling automatic Gemini", () => {
  const pool = createFreeProviderPool();
  const env = {
    GEMINI_API_KEY: "g1",
    GEMINI_2_API_KEY: "g2",
  };

  assert.deepEqual(pool.next(env), []);

  assert.deepEqual(
    pool.nextFor("gemini", env, { includeOptIn: true })
      .map((item) => item.keyName),
    ["GEMINI_API_KEY", "GEMINI_2_API_KEY"]
  );
});

test("unknown provider IDs return no credentials", () => {
  const pool = createFreeProviderPool();

  assert.deepEqual(pool.credentialsFor("openai", {
    OPENAI_API_KEY: "paid",
  }), []);

  assert.deepEqual(pool.nextFor("openai", {
    OPENAI_API_KEY: "paid",
  }), []);
});
