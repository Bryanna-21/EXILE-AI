/**
 * Capability-based provider routing for the artifact engine.
 *
 * Policy (mirrors EXILE's existing WhatsApp conversation routing):
 *   - Only free-tier-eligible providers are used: OpenRouter always, Gemini only when
 *     EXILE_GEMINI_FREE_TIER === "true". Paid providers are never selected silently.
 *   - An explicit EXILE_ARTIFACT_AI_PROVIDER (or the existing EXILE_WHATSAPP_AI_PROVIDER
 *     when the caller opts in) overrides the order, and fails loudly if unusable.
 *   - A provider that returns 429/5xx or times out enters a cooldown and is skipped until it expires.
 *   - A provider being configured does not imply it supports a capability: each capability
 *     lists which providers can serve it, and only local engines serve procedural graphics,
 *     documents, speech and video.
 *   - API keys stay inside this process. They are never returned, logged or written to files.
 */
import { ArtifactError, redact } from "./errors.mjs";

export const CAPABILITIES = Object.freeze({
  text: ["openrouter", "gemini"],
  // No cloud image/audio/video provider is wired in: those go through local engines.
  image: [],
  audio: [],
  video: [],
});

const COOLDOWN_MS = 60_000;

export function createTextRouter({ getProviders, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 30_000 }) {
  const cooldowns = new Map();

  function freeOrder() {
    return env.EXILE_GEMINI_FREE_TIER === "true" ? ["gemini", "openrouter"] : ["openrouter"];
  }

  function eligible(override) {
    const requested = String(override || env.EXILE_ARTIFACT_AI_PROVIDER || "").trim().toLowerCase();
    const configured = getProviders();
    const order = requested ? [requested] : freeOrder();
    // An explicit provider choice is the user's own opt-in and overrides the free-tier order,
    // but it must be a provider that is actually configured.
    if (requested && !configured.some((p) => p.id === requested)) {
      throw new ArtifactError("PROVIDER_FAILURE", `AI provider "${requested.slice(0, 30)}" is unavailable. Check the provider name and API key configuration.`);
    }
    return order.map((id) => configured.find((p) => p.id === id)).filter(Boolean);
  }

  function status() {
    const configured = getProviders();
    const order = freeOrder();
    return {
      text: {
        providers: order.filter((id) => configured.some((p) => p.id === id)),
        policy: env.EXILE_GEMINI_FREE_TIER === "true" ? "free-tier: gemini, openrouter" : "free-tier: openrouter only (Gemini free tier not enabled)",
        cooling: [...cooldowns.entries()].filter(([, until]) => until > now()).map(([id]) => id),
      },
      image: { providers: [], note: "No cloud image provider is used. Local procedural/SVG generation and optional local Stable Diffusion are available." },
      audio: { providers: [], note: "Speech uses local engines only." },
      video: { providers: [], note: "No video-generation provider is connected." },
    };
  }

  /** Ask a permitted provider for text. Throws PROVIDER_FAILURE when none can answer. */
  async function generateText({ system, prompt, maxTokens = 2400, temperature = 0.35, provider: override }) {
    const providers = eligible(override);
    if (!providers.length) throw new ArtifactError("PROVIDER_FAILURE", "No permitted free-tier AI provider is configured for text generation.");
    const errors = [];
    for (const p of providers) {
      if ((cooldowns.get(p.id) || 0) > now()) { errors.push(`${p.id}: cooling down`); continue; }
      const key = env[p.key];
      if (!key) { errors.push(`${p.id}: no key`); continue; }
      try {
        const response = await fetchImpl(`${p.base}/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: p.id === "openrouter" ? "openrouter/free" : (p.chat || "gemini-3.8-flash"),
            stream: false, max_tokens: maxTokens, temperature,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          }),
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) cooldowns.set(p.id, now() + COOLDOWN_MS);
          errors.push(`${p.id}: HTTP ${response.status}`);
          continue;
        }
        const data = await response.json();
        const value = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(value) ? value.map((part) => (typeof part === "string" ? part : part?.text || "")).join("") : value;
        if (typeof text === "string" && text.trim()) return { text: text.trim(), provider: p.id };
        errors.push(`${p.id}: empty response`);
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") cooldowns.set(p.id, now() + COOLDOWN_MS);
        errors.push(`${p.id}: ${redact(error.message)}`);
      }
    }
    throw new ArtifactError("PROVIDER_FAILURE", `No permitted provider could generate content (${errors.join("; ")}).`);
  }

  return { generateText, status, eligible: () => eligible().map((p) => p.id) };
}
