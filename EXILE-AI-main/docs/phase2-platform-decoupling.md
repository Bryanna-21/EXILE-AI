# Phase 2 — Platform decoupling and env validation

## Changes
- Removed `lovable-tagger`, `@lovable.dev/cloud-auth-js`, `@lovable.dev/vite-plugin-dev-server-bridge`, `@lovable.dev/vite-plugin-hmr-gate` from `package.json`; removed the tagger from `vite.config.ts`.
- `src/integrations/lovable/` (third-party OAuth adapter; had no importers) replaced by `src/integrations/supabase/auth.ts` using `supabase.auth.signInWithOAuth` directly (Microsoft maps to Supabase's `azure` provider). The provider must be enabled in the Supabase dashboard; not tested against a live project.
- `package-lock.json`: regenerated with `npm install --package-lock-only --ignore-scripts` in a scratch copy (shared `node_modules` untouched). No version or integrity drift for any retained package.
- **Install blocker fixed:** 54 lockfile entries resolved from a private mirror (`europe-west4-npm.pkg.dev/lovable-core-prod/...`) that outsiders cannot reach, so `npm ci` would fail. All 54 integrity hashes were checked against the public registry (54/54 identical) and the URLs repointed to `registry.npmjs.org`.
- `index.html`: removed Lovable social-preview image and Twitter handle. `README.md` rewritten (was platform boilerplate).
- `src/lib/env.ts` validates `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (missing, malformed, service-role-looking key). The Supabase client is now created lazily: the app starts without Supabase and the first Supabase call throws `EnvConfigError` naming the variables. No placeholder values are invented. `.env.example` added.

## Deliberately kept
- The **AI gateway** (`ai.gateway.lovable.dev`) is an inference service, not build tooling. It remains an optional provider in `local/server.mjs` (user supplies the key) and the default for the Supabase edge functions. Edge functions now read `AI_GATEWAY_API_KEY` / `AI_GATEWAY_URL` first, falling back to `LOVABLE_API_KEY` and the original URL so existing deployments keep working. Switching to another OpenAI-compatible gateway needs only those two secrets.
- `.lovable/plan.md` is a historical planning note; left in place.

## Known remaining risk
- `@whiskeysockets/baileys` pulls `libsignal-node` via `git+ssh://git@github.com/...`. `npm ci` on a machine without GitHub SSH access can fail on it. Pre-existing and unchanged; not fixed here.

## Tests
`test/decoupling.test.mjs`: no platform strings in manifests/config/source, lockfile registry hygiene, package.json/lock root consistency, env validation.
