# Phase 8 — Electron production release review

**Status: Windows installer NOT built and NOT tested.** This sandbox is Linux. Everything
below marked "verified" was verified on Linux only. Nothing here claims the NSIS installer works.

## Configuration review (`package.json` → `build`)

| Item | Finding |
|---|---|
| Target | `win` → `nsis`, `oneClick:false`, user can change install dir, desktop + start-menu shortcuts |
| Files | `dist/**`, `electron/**`, `local/**`, `package.json`; `asar:true`; output `electron-release-optimized/` |
| Dependencies packed | Reduced in commit 90fe02c: only runtime deps (baileys, docx, qrcode) remain in `dependencies`; frontend libs moved to `devDependencies` (previously ~408 MB of already-bundled libs would be packed) |
| Code signing | **None configured.** Installer will be unsigned → Windows SmartScreen warning |
| Auto-update | None (no `publish` config). Updates are manual reinstalls |
| `author` / `repository` | Not set in `package.json` (electron-builder warns; installer metadata is thin) |
| Icons | `npm run icons` generates assets before packaging; not exercised here |
| Local API | Spawned from the asar with `ELECTRON_RUN_AS_NODE`, per-launch secret passed by the launcher |

## Verified on Linux

- `electron-builder --linux dir` packages successfully; `app.asar` ≈ 44.6 MB.
- The packaged server runs from inside the asar under real Electron 43 with auth enforced (401 without secret, 200 with).
- Packaged app starts under Xvfb; `/health` returns online; log shows "Local API auth: secret supplied by launcher".
- Attached to the packaged renderer via CDP: both windows load `dist/index.html`; `window.exileDesktop` bridge present with a 43-char secret; `require` is undefined in the renderer (no node integration); `nativeApps.list()` succeeds through the bridge; a scripted navigation to `https://example.com/` was blocked (URL stayed on `dist/index.html`).

## NOT verified (requires Windows)

- `npm run package:win`, NSIS install/uninstall, shortcuts, per-user vs per-machine behaviour.
- Signing, SmartScreen, antivirus reaction.
- Real `.exe` launch; `.lnk` discovery and Windows path handling at runtime.
- Whether the 15 originally-reported Windows failures equal the tests skipped on Linux (they were classified statically; see phase 5 doc).
- Permission-handler behaviour for camera/mic prompts on Windows.

## Windows build/test checklist

1. `npm ci` (needs GitHub SSH/network access: a `libsignal` dependency resolves via `git+ssh`).
2. `npm run typecheck && npm test`.
3. `npm run package:win`; inspect `electron-release-optimized/`.
4. Install on a clean Windows VM; launch from the shortcut.
5. Check `%APPDATA%\EXILE AI\` logs and `exile-api.log` for "Local API is ready".
6. Run the native-apps tests under PowerShell (`node --test test/native-apps.test.mjs`) and confirm the skipped fixtures now execute.
7. Confirm unauthenticated `curl http://127.0.0.1:8787/keys` returns 401.
8. Uninstall; confirm user data handling is as intended.

## Blockers / recommended before release

- Obtain a code-signing certificate and add signing config.
- Add `author`, `repository`, and a `publish` target if auto-update is wanted.
- `npm ci` dependency on git+ssh `libsignal` will fail in CI without SSH keys; pin to a registry/https source.
- Run the checklist above on Windows.
