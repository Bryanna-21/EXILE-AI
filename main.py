#!/usr/bin/env python3
"""
EXILE — EXiled Intelligence, Liberated from Everything.
Your AI. Your PC. Your rules.

Single entry point for the local build:

    python main.py

It will:
  1. verify Node.js 18+ is installed
  2. create .env from .env.example on first run
  3. install npm dependencies if needed
  4. start the local API server  (http://localhost:8787)
  5. start the EXILE UI          (http://localhost:8080)
  6. open your browser

Paste your API keys inside the app: Settings -> API -> Connect & Run.
No keys are needed to boot; the offline rules engine and Ollama still work.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_PORT = int(os.environ.get("EXILE_PORT", "8787"))
UI_PORT = int(os.environ.get("EXILE_UI_PORT", "8080"))
NPM = "npm.cmd" if os.name == "nt" else "npm"


def info(msg: str) -> None:
    print(f"  {msg}", flush=True)


def die(msg: str) -> None:
    print(f"\n  ! {msg}\n", flush=True)
    sys.exit(1)


def check_node() -> None:
    if not shutil.which("node"):
        die("Node.js 18+ is required. Install it from https://nodejs.org")
    ver = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    try:
        major = int(ver.lstrip("v").split(".")[0])
    except ValueError:
        major = 0
    if major < 18:
        die(f"Node.js 18+ is required (found {ver}).")
    info(f"Node.js {ver}")


def ensure_env() -> None:
    env = ROOT / ".env"
    example = ROOT / ".env.example"
    if not example.exists():
        example = ROOT / "local" / ".env.example"
    if not env.exists() and example.exists():
        shutil.copyfile(example, env)
        info("Created .env — you can paste keys in the app under Settings -> API.")


def ensure_deps() -> None:
    if (ROOT / "node_modules").exists():
        return
    info("Installing dependencies (first run only)…")
    if subprocess.run([NPM, "install"], cwd=ROOT).returncode != 0:
        die("npm install failed.")


def wait_for(url: str, timeout: float = 90.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.6)
    return False


def main() -> None:
    print("\n  EXILE — EXiled Intelligence, Liberated from Everything")
    print("  Your AI. Your PC. Your rules.\n")

    check_node()
    ensure_env()
    ensure_deps()

    env = {**os.environ, "EXILE_PORT": str(API_PORT), "VITE_EXILE_LOCAL_API": f"http://localhost:{API_PORT}"}
    procs: list[subprocess.Popen] = []

    def shutdown(*_a) -> None:
        for p in procs:
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
        print("\n  EXILE offline.\n")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    info("Starting local API server…")
    procs.append(subprocess.Popen(["node", str(ROOT / "local" / "server.mjs")], cwd=ROOT, env=env))
    if not wait_for(f"http://localhost:{API_PORT}/health"):
        shutdown()

    info(f"API online  -> http://localhost:{API_PORT}")
    info("Starting EXILE UI…")
    procs.append(subprocess.Popen([NPM, "run", "dev", "--", "--port", str(UI_PORT)], cwd=ROOT, env=env))

    if wait_for(f"http://localhost:{UI_PORT}/", timeout=120):
        info(f"EXILE ready -> http://localhost:{UI_PORT}")
        info("Open Settings -> API, paste your keys, then press CONNECT & RUN.")
        try:
            webbrowser.open(f"http://localhost:{UI_PORT}/")
        except Exception:
            pass
    print("\n  Ctrl+C to shut down.\n", flush=True)

    while True:
        for p in procs:
            if p.poll() is not None:
                shutdown()
        time.sleep(1)


if __name__ == "__main__":
    main()
