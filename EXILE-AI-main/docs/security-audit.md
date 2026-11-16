# Security and privacy audit

Scope: local server, Electron shell, web client, dependencies, repository hygiene. Method: code reading plus a failing test
before each fix. Date: 2026-11-12. **Not** a penetration test; Electron was not launched (Linux sandbox).

## Threat model
EXILE is a single-operator desktop app. The local API listens on 127.0.0.1 and can act on the machine (launch/terminate
processes via the shell, send WhatsApp messages, spend provider quota, write API keys). Attackers considered: a malicious
web page in the operator's browser, another local process, hostile model output/files/attachments, and mistakes.
Not defended: malware running as the same OS user that can read process memory or the renderer.

## Fixed
| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | Local API had `Access-Control-Allow-Origin: *` and no authentication on `/keys`, `/exile-*`, `/arc/*`, `/whatsapp*`, `/tasks` (any web page could call them; `/tasks` handed out approval tokens) | High | Per-launch secret header, loopback Host + Origin checks, per-request CORS echo of loopback origins only | `server-auth.test.mjs`, `task-engine-hardening.test.mjs` |
| 2 | `/keys` wrote any variable name to `.env` and `process.env` (NODE_OPTIONS, PATH, ELECTRON_RUN_AS_NODE → code execution at next start) and allowed newline injection in values | High | Credential-shaped names only; reserved prefixes refused; control characters and unknown `primary` refused | `server-auth.test.mjs` |
| 3 | Static server checked `startsWith(DIST)`; `../dist-old/…` escaped into sibling directories | Low | Require path separator | `server-auth.test.mjs` |
| 4 | Request bodies buffered past the 25 MB limit; bad JSON returned 500 | Medium | Stop buffering, destroy connection, 413/400 | `server-auth.test.mjs` |
| 5 | Electron windows could navigate to remote pages with the privileged preload (native app launch, API secret) attached; all permissions auto-granted | High | `will-navigate`/`will-redirect` guard, `will-attach-webview` denied, permission allow-list for `file://` only; speech IPC verifies sender frame | `electron-config.test.mjs` (static; **runtime unverified**) |
| 6 | Task engine: approvals not revocable, tokens/records not validated, prototype-polluting keys | Medium | See `phase1-task-engine-audit.md` | `task-engine-hardening.test.mjs` |
| 7 | Process termination: could target the EXILE server/launcher; no audit trail | Medium | Self PIDs protected (JS + PowerShell); append-only `arc-audit.jsonl` without paths/command lines | `arc-hardening.test.mjs` |
| 8 | Launch rules applied to the stored path, not the resolved executable | Medium | Rules and path syntax enforced on both | `native-apps.test.mjs` |
| 9 | `memory.ts` claimed "encrypted-at-rest" but stores plain JSON | Honesty | Comment corrected | — |
| 10 | Lockfile pointed at a private package mirror | Supply chain / availability | Repointed to registry.npmjs.org, hashes verified | `decoupling.test.mjs` |

## Dependency advisories (`npm audit --omit=dev`)
16 → **5** after a non-breaking `npm audit fix` (build, typecheck, 204 tests passed on the fixed tree).
Remaining, not fixed, with reachability:
- `zod` <4.6.6 (high, memory exhaustion on oversized constrained collections): major upgrade; **not imported by app code** (transitive).
- `react-router`/`react-router-dom` (moderate: open redirect via backslash in `<Link>`/`useNavigate`; `deserializeErrors`): major upgrade; the app uses only `Routes`/`Route`, no `Link`/`useNavigate` with user input, no framework mode.
- `glob` (high, CLI command injection) and `minimatch` (moderate ReDoS): transitive in build/packaging tooling; the CLI is not invoked with untrusted input.
Re-evaluate when bumping React Router 7 / Zod 4 deliberately with a regression pass.

## Known risks not fixed
- **Vehicle/home access tokens and other integration configs are stored in plaintext `localStorage`** (`exile.car.config`, `exile.house.config`). Recommended: Electron `safeStorage` via a narrow IPC. Not done: it cannot be tested here.
- **No restrictive Content-Security-Policy.** The "live website canvas" renders generated HTML in a sandboxed `srcdoc` iframe; srcdoc frames inherit the parent's CSP, so a strict `script-src`/`connect-src` would break that feature. The iframe's `sandbox="allow-scripts"` (no `allow-same-origin`) is the control in place. Better long-term: host the canvas on a separate origin/blob with its own CSP, then tighten the shell's CSP.
- Chat text, memory, audit log, and sessions are device-scoped plain localStorage, not per-account and not encrypted.
- Local API secret is a bearer secret in the renderer's memory; XSS in the renderer would expose it. No `innerHTML`/`dangerouslySetInnerHTML`/`eval` was found in `src` outside generated UI primitives; links are limited to http(s).
- `libsignal-node` is fetched by `git+ssh` (supply-chain and install-reliability risk; pre-existing).
- Mapped credentials in the repo: none found (`git ls-files` shows only `.env.example` files; secret-pattern grep hits only fake test fixtures).

## Privacy notes
Local server logs key *names* and provider ids, never values. Task records redact secret-shaped strings. ARC audit stores PID, process name and outcome only. Chat media stays in the browser profile's IndexedDB. Prompts and attachments are sent to whichever provider the operator configures (not local-only).
