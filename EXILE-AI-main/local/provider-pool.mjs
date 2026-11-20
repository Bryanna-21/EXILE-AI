const FREE_PROVIDERS = [
  {
    id: "groq",
    prefix: "GROQ",
    base: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
  },
  {
    id: "openrouter",
    prefix: "OPENROUTER",
    base: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
  },
  {
    id: "gemini",
    prefix: "GEMINI",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    optIn: "EXILE_GEMINI_FREE_TIER",
  },
];

const COOLDOWN_MS = {
  rateLimit: 60_000,
  unauthorized: 300_000,
  transient: 15_000,
};

function retryAfterDuration(value, now) {
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 15 * 60_000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.min(date - now, 15 * 60_000))
    : 0;
}

export function createFreeProviderPool({ clock = Date.now } = {}) {
  let cursor = null;
  const providerCursors = new Map();
  const cooldowns = new Map();

  function credentialsFor(providerId, env = process.env, { includeOptIn = false } = {}) {
    const provider = FREE_PROVIDERS.find((item) => item.id === providerId);
    if (!provider) return [];

    if (
      provider.optIn &&
      !includeOptIn &&
      env[provider.optIn] !== "true"
    ) return [];

    const expression = new RegExp(
      `^${provider.prefix}(?:_(\\d+))?_API_KEY$`
    );

    return Object.keys(env)
      .map((name) => {
        const match = name.match(expression);
        return match && env[name]
          ? {
              id: provider.id,
              keyName: name,
              key: env[name],
              number: match[1] ? Number(match[1]) : 1,
              base: provider.base,
              model: provider.model,
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.number - b.number);
  }

  function credentials(env = process.env) {
    return FREE_PROVIDERS.flatMap((provider) =>
      credentialsFor(provider.id, env)
    );
  }

  function eligible(items) {
    const now = clock();
    return items.filter(
      (item) => (cooldowns.get(item.keyName) || 0) <= now
    );
  }

  function rotate(items, start) {
    if (!items.length) return [];
    const index = start % items.length;
    return [...items.slice(index), ...items.slice(0, index)];
  }

  function next(env = process.env) {
    const all = credentials(env);
    if (!all.length) return [];

    const preferred = String(env.EXILE_PRIMARY_PROVIDER || "")
      .trim()
      .toLowerCase();

    const preferredIndex = preferred
      ? all.findIndex((item) => item.id === preferred)
      : -1;

    const start = cursor === null
      ? (preferredIndex >= 0 ? preferredIndex : 0)
      : cursor % all.length;

    cursor = (start + 1) % all.length;
    return eligible(rotate(all, start));
  }

  function nextFor(providerId, env = process.env, options = {}) {
    const all = credentialsFor(providerId, env, options);
    if (!all.length) return [];

    const start = providerCursors.get(providerId) || 0;
    providerCursors.set(providerId, (start + 1) % all.length);

    return eligible(rotate(all, start));
  }

  function markFailure(item, status, retryAfter) {
    if (!item?.keyName) return;

    const now = clock();
    let duration = COOLDOWN_MS.transient;

    if (status === 429) {
      duration = Math.max(
        COOLDOWN_MS.rateLimit,
        retryAfterDuration(retryAfter, now)
      );
    } else if (status === 401 || status === 403) {
      duration = COOLDOWN_MS.unauthorized;
    }

    cooldowns.set(item.keyName, now + duration);
  }

  function markSuccess(item) {
    if (item?.keyName) cooldowns.delete(item.keyName);
  }

  function clearCooldowns() {
    cooldowns.clear();
  }

  return {
    credentials,
    credentialsFor,
    next,
    nextFor,
    markFailure,
    markSuccess,
    clearCooldowns,
  };
}
