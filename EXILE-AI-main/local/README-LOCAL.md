# EXILE — Local Build

**EXiled Intelligence, Liberated from Everything.**
_Your AI. Your PC. Your rules._

A JARVIS-style cognitive HUD that runs entirely on your machine: arc-reactor
core, voice in/out with cloning profiles, app registry, house & vehicle
control, research, image render, cinema storyboards, document intelligence.

---

## 1. Requirements

- **Node.js 18+** — https://nodejs.org

## 2. Setup (2 minutes)

```bash
# inside the folder:
python main.py            # Windows:  py main.py
```

`main.py` checks Node, installs dependencies, starts the local API server and
the UI, then opens your browser. No keys needed to boot.

Then, inside EXILE: **Settings (gear) → API → paste your keys → CONNECT & RUN**.
You can name keys anything (`GROQ_API_KEY`, `MY_API_KEY`, …), add up to 200, and
optionally set a preferred provider. Keys are written to your local `.env` and
applied instantly — no restart.

Shell launchers still work as an alternative:

```bash
./run.sh                  # macOS / Linux
run.bat                   # Windows
```

The launcher installs dependencies, starts the **local API server** on
`http://localhost:8787` and the **EXILE UI** on `http://localhost:8080`.

Default unlock passcode: **0000** (change it in `src/components/LockScreen.tsx`).

## 3. API keys

| Requirement | Value |
| --- | --- |
| Minimum keys | **2** |
| Maximum keys | **200** (any `*_API_KEY` in `.env` is auto-detected) |
| Zero-key mode | Works via the built-in offline rules engine |

EXILE tries providers in order and automatically falls through on failure:
`EXILE_PRIMARY_PROVIDER` → other configured keys → offline rules.

Supported out of the box: OpenAI, Groq, Google Gemini, OpenRouter, Together,
DeepSeek, Mistral, xAI, Perplexity, Lovable AI Gateway.

Check what loaded: `curl http://localhost:8787/health`

## 4. Features

- **Arc reactor HUD** — centres when idle, shrinks to the **top-left** during
  conversation, docks **bottom-right** when images/video/documents are on
  screen. Spikes react to your microphone; the core pulses with EXILE's speech.
- **Voice Lab** — record samples, tune pitch/rate/timbre, save multiple voice
  profiles, and set the active cloned voice EXILE speaks with.
- **Apps** — two kinds, shown separately. *Desktop apps* are programs on this
  computer (desktop build only, see section 4b). *Web links* are `https:`,
  `spotify:`, `mailto:`, `tel:` links that open in your browser
  (`javascript:`, `data:`, `file:` and similar links are refused).
- **Mission Control** — create and supervise tasks run by the EXILE task engine
  (section 4a), plus local goals and an honest capability audit.
- **Modules** — Console, Research, Cinema (4 still frames, no video), Docs,
  Vision, Systems (real checks), Access, House, Vehicle, WhatsApp, Optics, Vault,
  Share, Voice. **Calls only previews your own mic and camera; remote calling is
  not implemented.** Mission Control → Overview shows each module's true status
  (working / needs setup / partial / placeholder / desktop only).

### 4a. Mission Control and the task engine

Tasks are planned by a model and executed by one engine with a fixed tool
registry; there are no separate "agents" behind it. The UI talks to the existing
task API on the local server (no second orchestrator):

| Endpoint | Purpose |
| --- | --- |
| `GET /tasks?view=summary` | light list for the UI (the default `GET /tasks` is unchanged) |
| `GET /tasks/capabilities` | planner configured?, limits, tools and availability (never keys) |
| `POST /tasks`, `GET /tasks/:id`, `/events` | create, details, event timeline |
| `POST /tasks/:id/start \| pause \| resume \| cancel` | controls |
| `GET /tasks/:id/approval-challenge`, `POST /tasks/:id/approve` | human approval |

Behaviour worth knowing:

- Sensitive tools never run without an approval bound to that task, step, tool
  and exact arguments. Each approval is single-use; the UI shows the exact
  arguments before you approve.
- After a restart, running tasks come back **paused** with a recovery note. A
  step that was mid-flight is never replayed automatically.
- Planning needs a provider key. Without one, a new task fails at *planning*
  with a clear message and nothing else runs.
- The API only accepts requests from the local app (origin policy); other web
  origins get 403.
- Goals and milestones are stored in this browser only (`localStorage`). A
  milestone counts as done when ticked, or when its linked task is `completed`.

### 4b. Desktop applications (Electron build)

Import and launch programs on this computer from **Apps → Desktop apps**.

- **Windows is the supported platform.** Linux is experimental (manual import
  only); macOS is not supported yet. The code is structured so other platforms
  only need a validator and a discovery source.
- **Discovery** reads Start Menu `.lnk` shortcuts (`ProgramData` and the user's
  Start Menu). Reading a shortcut never runs its target. You pick what to add.
  Microsoft Store/UWP apps are not discovered; add an `.exe` manually.
- **Manual import:** *Browse for program* (an `.exe`) or *Import shortcut*.
- Each entry keeps name, path, arguments, category, favourite, icon, launch
  count/time. Duplicates (same program and arguments) are refused. *Check paths*
  flags missing or unreadable programs; *Relink* points an entry at a new file.
- **Importing and discovering never start a program.** Only the Launch button
  (or a tab's play button) does, and only for entries you added.
- **Tabs** list the programs you opened this way and survive restarts. EXILE
  does **not** embed native programs: they open in their own windows and a tab
  is just a handle. Closing a tab does not close the program.
- **Running status** is only known for processes EXILE started. Programs that
  hand off to another process (some launchers, single-instance apps) can show as
  "Not running" while their window is open.
- Data (the app list and the last 100 launches) is stored in the app's user
  data folder as `native-apps.json`. Nothing is sent anywhere.

**Security model.**

- The web page can never supply a program path. Paths come only from native file
  dialogs, shortcut reading, or discovery results held in the main process and
  referenced by id.
- Launch runs by stored id with `spawn(file, args, { shell: false })`; arguments
  are an array, never a command string, so `; & | > $()` are plain text.
- Changing arguments requires a native confirmation dialog. Interpreters
  (`cmd`, `powershell`, `node`, shells, …) can only be imported with no arguments.
- Windows paths must be local drive `.exe` files: UNC/device paths, alternate
  data streams, `..` and reserved names are rejected. Paths are re-checked
  (including symlink resolution) at launch.
- The preload exposes a frozen set of 13 `invoke` wrappers and no raw
  `ipcRenderer`. The main process checks each caller is the app's own `file://`
  page and validates every argument. `sandbox` and `contextIsolation` stay on.
- The child environment drops `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `EXILE_*`.

### 4c. Known limitations

- Not run on a real Windows/Electron desktop in this repository's CI-less
  environment; the main-process logic is tested against real files and
  processes on Linux and against Windows path rules, and the UI against the real
  IPC handlers in Chromium. Do a manual Windows pass before release.
- No live-provider task run has been verified (it needs your key).
- Camera, Voice dictation and Share depend on browser support and permissions.
- Vision/Docs need a model provider; PDFs need a text layer (no OCR).
- Home Assistant, Vehicle and WhatsApp need their own services and credentials.

## 5. Commands

```bash
npm install        # install dependencies
npm run dev        # UI only
npm run server     # local API only
npm run local      # both (what run.sh does)
npm run build      # production bundle in dist/
npm test           # all tests in test/
npm run typecheck  # TypeScript check
npm run lint       # eslint (has pre-existing findings, see below)
```

## 6. Troubleshooting

| Problem | Fix |
| --- | --- |
| "No provider could answer" | Check keys in `.env`, then `curl localhost:8787/health` |
| Mic/camera blocked | Browsers require `localhost` or HTTPS — use `localhost:8080` |

| Port in use | Change `EXILE_PORT` in `.env` |

## 7. Push to your own GitHub

```bash
git init
git add .
git commit -m "EXILE local build"
git branch -M main
git remote add origin https://github.com/<you>/exile.git
git push -u origin main
```
