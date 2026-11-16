# EXILE AI

A desktop-first AI workspace: React + TypeScript + Vite UI, an Electron shell, and a local Node server
(`local/server.mjs`, 127.0.0.1:8787) that hosts chat, task execution, ARC system monitoring and optional integrations.

## Quick start

```bash
npm ci
cp .env.example .env        # fill in Supabase values (optional for local-only use)
npm run local               # local API + Vite dev server, sharing a per-launch API secret
```

Other scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run electron`,
`npm run package:win` (Windows installer; must be run on Windows).

## Configuration

See `.env.example`. Supabase is optional: without it the app runs against the local server and
Supabase-backed features report a clear configuration error naming the missing variables.
Provider API keys for the local server go in `.env` (never committed); see `local/README-LOCAL.md`.

## Documentation

- `local/README-LOCAL.md` — local server and providers
- `docs/release-readiness.md` — release status, test results, blockers, next action
- `docs/phase1-task-engine-audit.md`, `phase2-platform-decoupling.md`, `phase4-chat-completion.md`,
  `phase5-native-apps-windows.md`, `security-audit.md`, `phase7-bundle-performance.md`,
  `phase8-electron-release-review.md`

## Architecture and security model (summary)

- Renderer (React/Vite) → local Node API on `127.0.0.1:8787` (`local/server.mjs`) → providers / tool registry /
  task orchestrator / ARC process manager. Electron (`electron/main.cjs`) spawns the API and passes a per-launch
  secret to the renderer through the preload bridge.
- Every protected local API route requires the `x-exile-local-auth` secret plus loopback Host/Origin checks;
  CORS is per-request, not wildcard. Risky tool actions go through the permission gateway.
- Electron windows block off-app navigation and only grant a short allow-list of permissions.
- Troubleshooting: check `exile-api.log` in the user-data folder; `GET /health` shows API status.

## Known limitations

See `docs/release-readiness.md` (Windows installer untested, unsigned, no strict CSP, provider voice/streaming
untested against real providers).
