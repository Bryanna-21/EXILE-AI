/**
 * Wiring for the default (production) artifact engine: store location, provider router and
 * delivery channels. Tests build their own engine from the same classes with fakes.
 */
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "./store.mjs";
import { ArtifactEngine } from "./engine.mjs";
import { createTextRouter } from "./provider-router.mjs";
import { createImageRouter } from "./image-provider-router.mjs";
import { createArtifactApiHandler } from "./api.mjs";

export function defaultArtifactDir(env = process.env, dataDir = process.cwd()) {
  return env.EXILE_ARTIFACT_DIR ? path.resolve(env.EXILE_ARTIFACT_DIR) : path.join(dataDir, ".exile-ai", "artifacts");
}

export function createDefaultArtifactEngine({ dataDir, getProviders, sendWhatsAppMedia, env = process.env, fetchImpl }) {
  const store = new ArtifactStore({ rootDir: defaultArtifactDir(env, dataDir || os.homedir()) });
  const textRouter = createTextRouter({ getProviders, env, ...(fetchImpl ? { fetchImpl } : {}) });
  const imageRouter = createImageRouter({ env, ...(fetchImpl ? { fetchImpl } : {}) });
  const engine = new ArtifactEngine({
    store,
    textRouter,
    imageRouter,
    senders: {
      // Resolves only after the WhatsApp sender itself resolves; it throws on any failure.
      whatsapp: async ({ to, dataUrl, filename, caption }) => {
        const out = await sendWhatsAppMedia(to, dataUrl, filename, caption);
        return { sent: out?.sent === true };
      },
    },
  });
  return { engine, store, handler: createArtifactApiHandler({ engine }) };
}

export { ArtifactStore, ArtifactEngine, createTextRouter, createArtifactApiHandler };
