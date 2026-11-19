# EXILE AI

EXILE AI is a desktop-oriented AI workspace for chat, automation, local system capabilities, and creative tools.

## Technologies
- React
- TypeScript
- Vite
- Electron
- Tailwind CSS
- Node.js

## Requirements
- Node.js
- npm

## Development

```bash
npm install
npm run dev
```

## Validation

```bash
npm test
npm run typecheck
npm run build
```

## Windows packaging

```bash
npm run package:win
```

## Project structure
- `src/` — frontend application
- `electron/` — desktop runtime and preload
- `local/` — local backend services
- `supabase/` — cloud functions and database configuration
- `test/` — automated tests

Keep API keys and credentials in local environment files. Never commit secrets.
