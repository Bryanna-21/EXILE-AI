const API_BASE = "https://gen.pollinations.ai";
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

function fail(message, code = "PROVIDER_FAILURE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseDataUrl(value) {
  if (typeof value !== "string") throw fail("A reference image is required.", "INVALID_INPUT");

  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw fail("Reference image must be a PNG, JPEG or WebP data URL.", "INVALID_INPUT");

  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
    throw fail("Reference image must be smaller than 10 MB.", "TOO_LARGE");
  }

  return { dataUrl: `data:${match[1].toLowerCase()};base64,${buffer.toString("base64")}`, buffer };
}

function hasNumericPricing(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return /^\s*-?\d+(?:\.\d+)?\s*$/.test(value);
  if (Array.isArray(value)) return value.some(hasNumericPricing);
  if (value && typeof value === "object") return Object.values(value).some(hasNumericPricing);
  return false;
}

function normalizeModels(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) throw fail("Pollinations returned an invalid model catalogue.");

  return rows
    .filter((row) => {
      const id = row?.id ?? row?.name;
      return typeof id === "string" && id.trim();
    })
    .map((row) => {
      const id = String(row.id ?? row.name).trim();
      const title = typeof row.title === "string"
        ? row.title
        : typeof row.display_name === "string"
          ? row.display_name
          : typeof row.name === "string"
            ? row.name
            : id;
      const pricing = row.pricing ?? null;
      const free = row.paid_only === false &&
        /\bFREE\b/i.test(title) &&
        !hasNumericPricing(pricing);

      return {
        id,
        name: title,
        description: typeof row.description === "string" ? row.description : "",
        input_modalities: Array.isArray(row.input_modalities) ? row.input_modalities : [],
        output_modalities: Array.isArray(row.output_modalities) ? row.output_modalities : [],
        paid_only: row.paid_only,
        free,
        pricing,
      };
    });
}

export function createImageRouter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 180_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("An image-provider fetch implementation is required.");

  let catalogue;
  let catalogueAt = 0;

  async function request(url, options = {}, timeout = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        let detail = "";
        try {
          const parsed = JSON.parse(body);
          detail = parsed?.error?.message || parsed?.message || "";
        } catch {
          detail = body.slice(0, 300);
        }
        throw fail(`Pollinations request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }

      return response;
    } catch (error) {
      if (error.name === "AbortError") throw fail("Pollinations image request timed out.", "TIMEOUT");
      if (error.code) throw error;
      throw fail(`Pollinations connection failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels({ refresh = false } = {}) {
    if (!refresh && catalogue && now() - catalogueAt < CATALOGUE_TTL_MS) return catalogue;

    const response = await request(`${API_BASE}/image/models`, { method: "GET" }, 30_000);
    const models = normalizeModels(await response.json());
    catalogue = models;
    catalogueAt = now();
    return models;
  }

  function apiKey() {
    const key = String(env.POLLINATIONS_API_KEY || "").trim();
    if (!key.startsWith("sk_")) {
      throw fail("Configure a Pollinations API key (sk_) in EXILE image-provider settings.", "UNCONFIGURED");
    }
    return key;
  }

  async function generate({
    prompt,
    model,
    width = 1024,
    height = 1024,
    referenceImage,
  }) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw fail("An image prompt is required.", "INVALID_INPUT");
    }
    if (prompt.length > 4000) throw fail("Image prompt exceeds 4,000 characters.", "TOO_LARGE");
    if (![256, 512, 768, 1024, 1536, 2048].includes(width) ||
        ![256, 512, 768, 1024, 1536, 2048].includes(height)) {
      throw fail("Unsupported image dimensions.", "INVALID_INPUT");
    }

    const key = apiKey();
    const models = await listModels();
    const editing = !!referenceImage;
    const freeModels = models.filter((item) => item.free === true);
    const eligible = freeModels.filter((item) =>
      !editing || item.input_modalities.includes("image")
    );

    if (!eligible.length) {
      throw fail(editing
        ? "No provider-labelled free contributor model currently supports image editing. No paid model was used."
        : "No verified provider-labelled free contributor image model is currently available. No paid model was used.",
      "FREE_MODEL_UNAVAILABLE");
    }

    const selected = model
      ? eligible.find((item) => item.id === model)
      : eligible[0];

    if (!selected) {
      const listed = models.find((item) => item.id === model);
      if (listed && listed.free !== true) {
        throw fail("The selected model is not verified as free by Pollinations. Paid models are blocked.", "PAID_MODEL_BLOCKED");
      }
      throw fail(editing
        ? "The selected free model does not support reference-image editing."
        : "The selected image model is not in the current free Pollinations catalogue.",
      "INVALID_INPUT");
    }

    const payload = {
      model: selected.id,
      prompt: prompt.trim(),
      size: `${width}x${height}`,
      response_format: "b64_json",
    };

    let endpoint = `${API_BASE}/v1/images/generations`;

    if (editing) {
      const reference = parseDataUrl(referenceImage);
      payload.image = reference.dataUrl;
      endpoint = `${API_BASE}/v1/images/edits`;
    }

    const response = await request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    const encoded = result?.data?.[0]?.b64_json;

    if (typeof encoded !== "string" || !encoded.trim()) {
      throw fail("Pollinations returned no base64 image data.");
    }

    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > 30 * 1024 * 1024) {
      throw fail("Pollinations returned an empty or oversized image.", "TOO_LARGE");
    }

    return {
      buffer,
      provider: "pollinations",
      model: selected.id,
      pricing: selected.pricing,
      edited: editing,
    };
  }

  return Object.freeze({ listModels, generate });
}
