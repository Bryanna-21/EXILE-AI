# Phase 1 — Task execution engine audit

Scope: `local/task-*.mjs`, `permission-gateway.mjs`, `tool-registry.mjs`, `task-api.mjs`, plus the local API boundary.
Method: read each module, then reproduce each suspected defect with a failing test before fixing it.

## What already held up
Schema-validated plans (model output never trusted), authoritative registry risk classes, hashed single-use approval tokens bound to task/step/tool/args, atomic task-file writes, DAG validation with a mandatory final `state_check`.

## Defects found and fixed
| # | Defect | Fix | Test |
|---|---|---|---|
| 1 | Cancel/timeout waited for a hung tool or model call; only checked between steps | AbortController per task; model and tool calls race the signal; per-tool timeout (default 30 s); task-level deadline | `cancel interrupts a hung tool…`, `task timeout…`, `a hung model call…` |
| 2 | An interrupted non-safe tool could be silently replayed on resume | Interrupted non-safe steps are flagged `uncertainSideEffects` with a recovery note | same |
| 3 | Approvals could not be withdrawn; a cancelled task left usable grants | `revoke`/`revokeForTask`; revoked on cancel and every terminal status; request table capped (429) | `approvals: …` |
| 4 | Approval consumed before argument validation/availability/abort checks | Consumed immediately before execution only | `registry: an approval is not consumed…` |
| 5 | Retries could duplicate side effects (memory notes, audit lines) | Idempotency key `taskId:stepId`; memory/audit writes deduplicate | `retries cannot duplicate…` |
| 6 | `output_present` passed on `null`/`{}`/whitespace; execution and verification were conflated | `isMeaningfulOutput`; `execution` recorded separately from `verificationResult`; verifier crashes and timeouts are failed verifications | `verification: …` |
| 7 | Corrupt task file or index could crash listing or hide all tasks | Records validated on read/write; corrupt files quarantined (`.corrupt-<ts>`, never deleted); index rebuilt from task files; index writes under a cross-process lock | `store: …` |
| 8 | `__proto__`/`constructor`/`prototype` keys survived into stored records and approval hashes | Dropped on persist; rejected in approval arguments | `store: prototype-polluting…`, `approvals: reserved keys…` |
| 9 | Task files and directory world-readable | Mode 0600/0700 (POSIX) | `store: secrets are redacted…` |
| 10 | `/tasks`, including the approval-challenge route that hands out approval tokens, relied only on an Origin check — any local process could approve its own request | Per-launch secret header, loopback Host check, strict Origin check; no wildcard CORS | `API: …`, `server-auth.test.mjs` |
| 11 | Server routes `/keys`, `/exile-chat`, `/exile-image`, `/exile-analyze`, `/arc/*`, `/whatsapp*` had `Access-Control-Allow-Origin: *` and no auth | Same gate applied to all of them; `/health` and static assets stay open | `server-auth.test.mjs` |
| 12 | Loose request bodies | Strict `parseCreateBody` / `parseApproveBody`; task-id format validated | `API: request schemas…` |

## Secret distribution
Electron main generates the secret in memory, passes it to the API child via environment and to renderers via `additionalArguments` (preload exposes `exileDesktop.localApiSecret`). `npm run local` generates one for both processes (dev only: Vite exposes `VITE_*` to the dev page). A standalone server generates its own and injects it into the `index.html` it serves to a loopback Host. `src/lib/localApi.ts` attaches it to loopback requests only.

## Limits (honest)
- The secret stops other web origins, DNS rebinding and other local processes that don't hold it. It does not stop malware running as the same user that can read process memory.
- Pause is cooperative (stops at the next step boundary). Cancel and timeout are interrupting.
- Interruption can only cancel I/O that honours `ctx.signal`; a tool that ignores it is abandoned (its result discarded), and its side effects, if any, are flagged as uncertain.
- The Windows Electron path (`additionalArguments`, sandboxed preload `process.argv`) is unverified here: this Linux sandbox cannot launch it.
