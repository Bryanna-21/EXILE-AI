export function createWhatsAppProviderRouter({
  pool,
  providers,
  env = process.env,
}) {
  const freeProviderIds = new Set(["groq", "openrouter", "gemini"]);

  function getProviders(requestedProvider = "", { media = false } = {}) {
    // Media analysis is always Gemini-only, including numbered Gemini keys.
    if (media) {
      return pool.nextFor("gemini", env, { includeOptIn: true });
    }

    if (requestedProvider) {
      if (freeProviderIds.has(requestedProvider)) {
        return pool.nextFor(requestedProvider, env);
      }

      // Paid providers are available only through explicit selection.
      const configured = providers.find(
        (provider) => provider.id === requestedProvider && env[provider.key]
      );

      return configured
        ? [{
            id: configured.id,
            keyName: configured.key,
            key: env[configured.key],
            base: configured.base,
            model: configured.chat,
            chat: configured.chat,
          }]
        : [];
    }

    return pool.next(env);
  }

  function markFailure(provider, status, retryAfter) {
    if (freeProviderIds.has(provider?.id)) {
      pool.markFailure(provider, status, retryAfter);
    }
  }

  function markSuccess(provider) {
    if (freeProviderIds.has(provider?.id)) {
      pool.markSuccess(provider);
    }
  }

  return {
    getProviders,
    markFailure,
    markSuccess,
  };
}
