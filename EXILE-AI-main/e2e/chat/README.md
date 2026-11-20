# Chat browser checks (Playwright + Chromium)

Not part of `npm test`: they need a built UI and a mock cloud. They exercise the real UI in a real browser.

```bash
npx vite build --outDir /tmp/exile-e2e-dist --emptyOutDir
node e2e/chat/mock-server.cjs &                          # mock chat/image API on :8787 (and :8799)
python3 -m http.server 4177 --directory /tmp/exile-e2e-dist &
SHOTS=/tmp/exile-shots node e2e/chat/e2e.cjs             # functional sweep (71 checks)
node e2e/chat/stop.cjs                                   # stop generation + stale-run guard
node e2e/chat/persist.cjs                                # media survives reload; delete removes it
N=600 node e2e/chat/long.cjs                             # long-conversation timings
```
`playwright` must be resolvable (`NODE_PATH=$(npm root -g)` if installed globally).
The mock is a test double: it proves the client behaves correctly, not that any real provider does.
