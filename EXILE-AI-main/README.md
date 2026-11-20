# EXILE AI

EXILE AI is a desktop-first AI workspace built with React, TypeScript, Vite, Electron, and a local Node.js server. It combines AI chat, automation, task execution, system monitoring, and creative tools.

## Technologies

- React and TypeScript
- Vite
- Electron
- Tailwind CSS
- Node.js
- Supabase (optional for local-only use)

## Requirements

- Node.js
- npm

## Quick start

Install dependencies:

    npm ci

Configure local environment variables in `.env` using `.env.example` as a reference.

Start the local server:

    npm run local

Start the development interface:

    npm run dev

## Validation

    npm test
    npm run typecheck
    npm run lint
    npm run build

## Desktop

    npm run electron
    npm run package:win

## Documentation

- local/README-LOCAL.md — local server and providers
- docs/release-readiness.md — release status and blockers
- docs/phase1-task-engine-audit.md
- docs/phase2-platform-decoupling.md
- docs/phase4-chat-completion.md
- docs/phase5-native-apps-windows.md
- docs/security-audit.md
- docs/phase7-bundle-performance.md
- docs/phase8-electron-release-review.md

## Architecture and security

The React/Vite renderer communicates with the local API at 127.0.0.1:8787. The API connects to provider integrations, the tool registry, task orchestrator, and ARC process manager.

Electron spawns the local API and passes a per-launch secret to the renderer through the preload bridge.

Protected local API routes require the x-exile-local-auth secret and loopback Host/Origin checks. CORS is handled per request. Risky tool actions pass through the permission gateway.

Electron windows block off-app navigation and restrict permissions.

For troubleshooting, inspect exile-api.log in the user-data folder. GET /health reports API status.

## Project structure

- src/ — React application and UI
- local/ — local API, provider integrations, and artifact engine
- electron/ — desktop shell and preload bridge
- supabase/ — optional hosted functions
- docs/ — architecture and release documentation
- test/ — automated tests

## Known limitations

Consult docs/release-readiness.md for current release blockers. Windows installer signing and validation, strict Content Security Policy, and real-provider voice/streaming validation may remain outstanding.
