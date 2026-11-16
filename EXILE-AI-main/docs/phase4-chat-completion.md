# Phase 4 — Chat completion

| Item | State | Evidence |
|---|---|---|
| Stop generation | Done. Abort cancels the network read (`reader.cancel`), never retries, never falls back to the offline answer; partial text is kept and marked "— stopped". | `test/stream-abort.test.mjs`; `e2e/chat/stop.cjs` (server observed the client disconnect; 6/6 repeat runs) |
| Stale-response guard | Done. An epoch is bumped on stop, new conversation and session switch; late chunks/finish/image callbacks from older runs are dropped. | `stop.cjs` (new conversation mid-reply discards the stream) |
| Durable media | Done. IndexedDB, 150 MB per scope, oldest-first eviction, memory fallback reported via `chatMedia.durable`. Delete (after the Undo window), session delete and wipe remove stored media. | `test/chat-media-db.test.mjs`; `e2e/chat/persist.cjs` |
| Validation | Done. Magic-byte checks for PNG/JPEG/WebP/PDF/text; empty and mislabelled files rejected. Size/count limits unchanged. | `test/chat-validate.test.mjs` |
| Long conversations | Fixed a real defect: typing re-rendered the whole history. 600 msgs: 292 → 36 ms median keystroke frame; 2000 msgs: 1304 → 77 ms (Chromium, headless, this sandbox). The list is still not virtualised (2000 msgs = 69k DOM nodes). | `e2e/chat/long.cjs` |
| Error/retry | Existing: failures produce a labelled local answer ("local answer" badge) and Regenerate re-runs online. Not redesigned. | `e2e.cjs` |

## Limits (honest)
- **User isolation:** chat text, sessions, memory and audit are device-scoped in localStorage; there is no per-account separation. Media is stored under one `device` scope (the store supports scopes, but nothing partitions by signed-in user). Treat the app as single-operator per browser profile/OS user.
- Media of a message deleted and then the page closed within the 7 s Undo window can remain as an orphan record until wipe.
- IndexedDB persistence was verified in Chromium only. Electron's renderer is Chromium, but it was not run here.
- Voice and streaming-over-real-providers were not tested against live services; the mock proves client behaviour only. Voice input/output is unchanged and not claimed complete by this phase.
- One earlier Stop run showed 2 failing checks (8/10). They were traced to a test reading the text before the "stopped" marker rendered; after waiting for the marker, 6/6 passed. A product-side render lag of a frame or two after Stop is possible.
