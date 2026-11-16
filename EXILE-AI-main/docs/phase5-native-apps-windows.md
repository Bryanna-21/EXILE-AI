# Phase 5 — Native application management on Windows

## What was reported
109/124 passing on the owner's Windows machine: 15 native-app failures.

## What I could and could not do here
This sandbox is Linux. I could **not** run the suite on Windows, and I could not see the 15 failure messages.
A global `path`→`win32` simulation breaks Node's own module loader, so it is not a valid reproduction.
Classification below is therefore by **static analysis of the test fixtures**, not observed failures. Treat it as a
strong hypothesis until the command at the bottom is run on Windows.

## Classification
| Class | Evidence | Action |
|---|---|---|
| **Test-fixture, POSIX-only** (expected cause of all 15) | `makeProbeApp()` writes a `#!/bin/sh` script and the service really `spawn()`s it; other tests rely on exec bits (`mode 0o755`), `/bin/sh`, a shebang to a nonexistent interpreter, and `fs.symlinkSync` (needs elevation on Windows). 18 tests use one of these. Windows cannot execute a shell script as a program. | Marked `skip` **only when `process.platform === "win32"`** with the reason in the output. They still run on Linux/macOS (CI here: all pass). 3 of the 18 may actually pass on Windows; skipping them loses little. |
| **Product defect: launch rules checked the stored path, not the executed path** | New test: a stored `.exe` that resolves (junction/symlink) to `cmd.exe` with arguments was launched. | **Fixed** (`service.cjs`): path-syntax and program/argument rules now apply to both the stored and the resolved path. UNC/relative/non-Windows resolved paths are refused. |
| **Product weakness: atomic save failed on transient locks** | `fs.renameSync` over an existing file throws EPERM/EBUSY/EACCES on Windows while antivirus/indexers hold it. Not reproducible on Linux. | **Fixed**: `local/fs-retry.cjs` retries with back-off on Windows only (native app list, task store, task memory, WhatsApp stores). Simulated in tests; not observed on real Windows. |

## New Windows regression tests (run on every OS)
`windows launch contract` (5 tests): no shell, argv array preserved (spaces not re-split), resolved path used,
`cwd` by Windows rules, `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`/`EXILE_*` scrubbed, already-running guard and exit tracking,
OS error codes (ENOENT/EPERM/EACCES/UNKNOWN/EFTYPE) mapped and recorded, moved program and `cmd.exe`+args refused,
relative/UNC/rooted resolved paths refused. Plus 4 tests for the rename retry (including a simulated EBUSY through the real store).
They inject `spawn`/`inspect`, so they prove the **contract**, not that Windows actually starts a process.

## Still unverified (needs a Windows run)
- That a real `.exe` launches and is tracked through `exit`.
- Real `.lnk` discovery (`shell.readShortcutLink`), icon extraction, native dialogs.
- Whether the 15 failures are exactly the skipped set. **Run on Windows and send the output:**

```powershell
npm ci
node --test --test-reporter=spec test/native-apps.test.mjs 2>&1 | Tee-Object native-apps-windows.txt
```
Expected after this change: 0 failures; ~18 shown as `skipped` with the POSIX-fixture reason. Any failure other than a skip is a real Windows finding.
