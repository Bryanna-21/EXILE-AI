# Phase 7 — Bundle performance

Measured with `vite build` in this sandbox (sizes as reported by Vite; gzip from Vite).

| | Before | After |
|---|---|---|
| Entry JS (first load) | 2,447 KB / **778 KB gzip** | 749 KB / **225 KB gzip** |
| Entry CSS | 110 KB / 20.0 KB gzip | 105 KB / 18.7 KB gzip |
| Chunks | 1 JS + pdf worker | entry + 24 lazy panel chunks + on-demand editor/highlighter/pdf.js |

First-load JS gzip: **−71 %**.

## What moved out of the entry chunk
- All 24 feature panels (`renderPanel` switch in `Index.tsx`), `CompanionWindow` and `NotFound` → `React.lazy` with `Suspense`.
- `pdfjs-dist` (484 KB / 145 KB gzip plus a 1.26 MB worker): loaded only when a PDF is attached (`loadPdfJs`).
- CodeMirror editor (`CodeCanvas`, only in the "open in editor" dialog) → lazy.
- Syntax-highlighting parsers (Lezer language packs): loaded on first code block/preview via `useHighlightedSegments`; code shows as plain text until the chunk arrives, then highlights.
- Unused `ChatSection` import removed (it was not rendered).

## What remains large in the entry (from sourcemap attribution before this change: react-dom 128 KB, Supabase client ~180 KB incl. realtime/auth/storage, TanStack Query 25 KB, Radix/shadcn primitives, app code ~160 KB)
Next candidates, not done: import only the Supabase auth/PostgREST pieces (the app uses auth + 3 tables), drop `@tanstack/react-query` if unused for real queries, and audit the Radix components pulled by the chat screen.

## Behaviour changes to know about
- Opening a panel/editor for the first time now shows a short "LOADING…" state while its chunk loads (local files in Electron, so typically instant).
- Code in messages appears unhighlighted for a moment on the very first code block.
- Not measured: real-device startup time, Electron cold start. Numbers are build output sizes, not runtime timings. Typing latency with 600 messages is 23 ms median in headless Chromium (was 292 ms before Phase 4's fix).

## Verification
`npm run typecheck`, unit suite (212/212), and the Chromium suites (functional 71 checks, stop, persistence, long-conversation) pass on the split build. One earlier functional run showed a single failure in "768px: composer and send button visible" that did not reproduce in 3 following runs; treated as a timing flake, not investigated further.
