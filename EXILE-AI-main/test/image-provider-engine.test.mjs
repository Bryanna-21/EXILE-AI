import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ArtifactStore } from "../local/artifacts/store.mjs";
import { ArtifactEngine } from "../local/artifacts/engine.mjs";

async function setup(imageRouter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "exile-cloud-image-"));
  const store = new ArtifactStore({ rootDir: root });
  const engine = new ArtifactEngine({ store, imageRouter });
  return {
    root, store, engine,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function png(value = 80) {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="rgb(${value},40,180)"/>
          <stop offset="1" stop-color="rgb(20,190,70)"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" fill="url(#g)"/>
      <circle cx="64" cy="64" r="28" fill="#f5c542"/>
    </svg>
  `);
  return sharp(svg).png().toBuffer();
}

test("cloud image generation validates and stores a PNG artifact", async () => {
  const imageRouter = {
    generate: async () => ({
      buffer: await png(),
      provider: "pollinations",
      model: "mock-image-model",
    }),
  };
  const t = await setup(imageRouter);
  try {
    const result = await t.engine.createProviderImage({
      prompt: "A mountain landscape",
      width: 512,
      height: 512,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.version, 1);
    assert.equal(result.validation.passed, true);

    const stored = await t.engine.read(result.artifactId);
    assert.equal(stored.meta.kind, "image");
    assert.equal(stored.meta.format, "png");
    assert.equal(stored.record.version, 1);
  } finally {
    await t.cleanup();
  }
});

test("reference edit creates a new version under the same artifact ID", async () => {
  let calls = 0;
  const imageRouter = {
    generate: async () => {
      calls++;
      return {
        buffer: await png(150),
        provider: "pollinations",
        model: "mock-edit-model",
        edited: true,
      };
    },
  };
  const t = await setup(imageRouter);
  try {
    const original = await t.engine.create({
      format: "png",
      name: "original.png",
      spec: { procedural: { type: "gradient", title: "Original", width: 128, height: 128 } },
    });
    assert.equal(original.success, true, original.error);

    const edited = await t.engine.createProviderImage({
      prompt: "Make the sky brighter",
      referenceImage: `data:image/png;base64,${(await png()).toString("base64")}`,
      artifactId: original.artifactId,
      artifactVersion: 1,
    });

    assert.equal(edited.success, true, edited.error);
    assert.equal(edited.artifactId, original.artifactId);
    assert.equal(edited.version, 2);
    assert.equal(calls, 1);

    const latest = await t.engine.read(original.artifactId);
    const previous = await t.engine.read(original.artifactId, 1);
    assert.equal(latest.record.version, 2);
    assert.equal(previous.record.version, 1);
    assert.notEqual(
      latest.record.sha256,
      previous.record.sha256,
      "the edit must create different image bytes",
    );
  } finally {
    await t.cleanup();
  }
});

test("stale image edits are rejected before calling the provider", async () => {
  let calls = 0;
  const imageRouter = {
    generate: async () => {
      calls++;
      return { buffer: await png(), provider: "pollinations", model: "mock" };
    },
  };
  const t = await setup(imageRouter);
  try {
    const original = await t.engine.create({
      format: "png",
      spec: { procedural: { type: "gradient", title: "Original", width: 128, height: 128 } },
    });
    assert.equal(original.success, true, original.error);

    await t.store.addVersion(original.artifactId, {
      buffer: await png(100),
      validation: { passed: true, checks: [], failures: [], skipped: [] },
      source: { method: "test" },
      metadata: {},
    });

    const stale = await t.engine.createProviderImage({
      prompt: "Edit this image",
      referenceImage: "data:image/png;base64,AAAA",
      artifactId: original.artifactId,
      artifactVersion: 1,
    });

    assert.equal(stale.success, false);
    assert.match(stale.error, /newer version/i);
    assert.equal(calls, 0);
    assert.equal((await t.store.get(original.artifactId)).currentVersion, 2);
  } finally {
    await t.cleanup();
  }
});

test("cloud provider failure returns an error without procedural fallback", async () => {
  const imageRouter = {
    generate: async () => {
      throw new Error("Mock cloud provider unavailable");
    },
  };
  const t = await setup(imageRouter);
  try {
    const result = await t.engine.createProviderImage({
      prompt: "A photorealistic city",
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Mock cloud provider unavailable/);
    assert.equal((await t.store.list()).length, 0);
  } finally {
    await t.cleanup();
  }
});
